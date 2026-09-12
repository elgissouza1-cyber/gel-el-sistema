import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pg from 'pg';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL não configurada');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 30000 });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const cents = n => Math.round(Number(n || 0));
const moneyPayload = c => ({ cents: c, value: c / 100 });
const publicBase = () => (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const storeUrl = () => process.env.PUBLIC_STORE_URL || publicBase() || 'https://gel-el.com.br';
const uberAuthUrl = 'https://auth.uber.com/oauth/v2/token';
const uberApiBase = 'https://api.uber.com';

let uberTokenCache = { token: null, expiresAt: 0 };
async function getUberAccessToken() {
  const clientId = process.env.UBER_DIRECT_CLIENT_ID;
  const clientSecret = process.env.UBER_DIRECT_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('Uber Direct não está configurado no servidor.');
  if (uberTokenCache.token && Date.now() < uberTokenCache.expiresAt - 60000) return uberTokenCache.token;
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials', scope: 'eats.deliveries' });
  const r = await fetch(uberAuthUrl, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body });
  const data = await r.json().catch(()=>({}));
  if (!r.ok || !data.access_token) throw new Error(`Uber OAuth falhou (${r.status}).`);
  uberTokenCache = { token:data.access_token, expiresAt:Date.now()+Number(data.expires_in||2592000)*1000 };
  return data.access_token;
}
function deliveryAddressText(a){
  return [a?.street && `${a.street}, ${a.number||'s/n'}`, a?.complement, a?.neighborhood, a?.city, a?.state, a?.cep].filter(Boolean).join(', ');
}

async function initDb() {
  const schema = await fs.readFile(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_estimate_id TEXT, ADD COLUMN IF NOT EXISTS delivery_estimate_expires_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS uber_delivery_order_id TEXT, ADD COLUMN IF NOT EXISTS uber_tracking_url TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS delivery_quotes (estimate_id TEXT PRIMARY KEY, fee_cents INTEGER NOT NULL, currency_code TEXT NOT NULL DEFAULT 'BRL', expires_at TIMESTAMPTZ NOT NULL, provider TEXT NOT NULL DEFAULT 'UBER_DIRECT', address JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM products');
  if (rows[0].count === 0) {
    await pool.query(`
      INSERT INTO products (name, description, price_cents, category, stock, active) VALUES
      ('Maracujá com gotas','',400,'Geladinhos',20,true),
      ('Maracujá trufado','',500,'Geladinhos',20,true),
      ('Ninho com morango','',500,'Geladinhos',15,true),
      ('Prestígio','',500,'Geladinhos',18,true),
      ('Cupuaçu ao leite','',400,'Geladinhos',12,true),
      ('Pudim','',500,'Sobremesas',10,true)
    `);
    console.log('Produtos iniciais carregados no banco.');
  }
}

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, database: 'connected', whatsapp: Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID) }); }
  catch { res.status(503).json({ ok: false, database: 'unavailable' }); }
});

// ---------- WhatsApp Cloud API webhook ----------
app.get('/api/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(String(challenge));
  return res.sendStatus(403);
});

app.post('/api/webhooks/whatsapp', (req, res) => {
  // Meta expects a fast 200 response. Processing happens after acknowledgement.
  res.sendStatus(200);
  void processWhatsAppWebhook(req.body).catch(err => console.error('WhatsApp webhook error:', err));
});

async function processWhatsAppWebhook(body) {
  const changes = body?.entry?.flatMap(e => e.changes || []) || [];
  for (const change of changes) {
    const value = change.value || {};
    const messages = value.messages || [];
    for (const message of messages) {
      if (message.type !== 'text') continue;
      const from = message.from;
      const text = (message.text?.body || '').trim();
      if (!from || !text) continue;
      await handleIncomingWhatsApp(from, text);
    }
  }
}

async function sendWhatsAppText(to, text) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const version = process.env.META_GRAPH_VERSION || 'v25.0';
  if (!token || !phoneNumberId) throw new Error('WhatsApp Cloud API não configurada');
  const r = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: true, body: text } })
  });
  if (!r.ok) console.error('WhatsApp send failed:', await r.text());
}

async function handleIncomingWhatsApp(from, text) {
  const normalized = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/^(oi|ola|olá|bom dia|boa tarde|boa noite|menu|cardapio|cardápio|precos?|preços?)$/.test(normalized)) {
    const { rows } = await pool.query(`SELECT name,price_cents FROM products WHERE active=true AND stock>0 ORDER BY category NULLS LAST, name`);
    const lines = rows.length ? rows.map(p => `• ${p.name} — R$ ${(p.price_cents/100).toFixed(2).replace('.', ',')}`) : ['No momento estamos sem produtos disponíveis.'];
    await sendWhatsAppText(from, `Olá! 💜 Bem-vindo(a) à Gel & El Suquinhos Gourmet!\n\nNossos produtos disponíveis:\n${lines.join('\n')}\n\nPara fazer o pedido pelo site:\n${storeUrl()}\n\nSe precisar, escreva *PEDIDO* para receber o link novamente.`);
    return;
  }
  if (normalized.includes('link') || normalized.includes('pedido') || normalized.includes('comprar') || normalized.includes('site')) {
    await sendWhatsAppText(from, `Claro! 💜 Faça seu pedido pelo nosso site:\n${storeUrl()}\n\nSe quiser saber sabores e preços, escreva *CARDÁPIO*.`);
    return;
  }
  if (normalized.includes('horario') || normalized.includes('funcionamento')) {
    await sendWhatsAppText(from, `Nosso atendimento é pelo WhatsApp e pelo site. 💜\n\nPara o horário atualizado, consulte o Gestor da Gel & El ou escreva *PEDIDO* para acessar o site.`);
    return;
  }
  await sendWhatsAppText(from, `Oi! 💜 Sou o atendimento automático da Gel & El.\n\nPosso ajudar com:\n• *CARDÁPIO* — sabores e preços\n• *PEDIDO* — link para comprar\n\nSe precisar falar com uma pessoa, escreva *ATENDENTE*.`);
}

// ---------- Customer / order API ----------
app.get('/api/products', async (_req, res) => {
  const { rows } = await pool.query(`SELECT id,name,description,price_cents,category,photo_url,stock,active FROM products WHERE active=true ORDER BY id`);
  res.json(rows.map(p => ({ ...p, price: p.price_cents / 100 })));
});

app.get('/api/reviews', async (_req, res) => {
  const { rows } = await pool.query(`SELECT r.id,r.stars,r.comment,r.created_at,o.id AS order_id FROM reviews r JOIN orders o ON o.id=r.order_id WHERE o.payment_status='PAID' AND o.customer_confirmed_at IS NOT NULL ORDER BY r.created_at DESC`);
  const rated = rows.filter(r => r.stars != null);
  const avg = rated.length ? Number((rated.reduce((a,r)=>a+r.stars,0)/rated.length).toFixed(1)) : null;
  res.json({ average: avg, total: rows.length, reviews: rows });
});

app.post('/api/delivery/estimate', async (req,res)=>{
  const { address, orderValueCents=0 } = req.body || {};
  if (!address?.cep || !address?.number || !address?.street) return res.status(400).json({error:'Endereço incompleto.'});
  const mode = String(process.env.DELIVERY_QUOTE_MODE || 'uber').toLowerCase();
  try {
    if (mode === 'mock') {
      const estimateId = `MOCK-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      const feeCents = Math.max(500, Math.round(Number(process.env.MOCK_DELIVERY_FEE_CENTS || 500)));
      const expiresAt = new Date(Date.now()+15*60*1000);
      await pool.query(`INSERT INTO delivery_quotes(estimate_id,fee_cents,currency_code,expires_at,provider,address) VALUES($1,$2,'BRL',$3,'MOCK',$4)`,[estimateId,feeCents,expiresAt,address]);
      return res.json({provider:'MOCK',estimateId,feeCents,deliveryFee:feeCents/100,currency:'BRL',expiresAt:expiresAt.toISOString()});
    }
    const storeId = process.env.UBER_DIRECT_STORE_ID;
    if (!storeId) return res.status(503).json({error:'Uber Direct ainda não está configurado: falta UBER_DIRECT_STORE_ID.'});
    const token = await getUberAccessToken();
    const formatted = deliveryAddressText(address);
    const payload = { pickup:{store_id:storeId}, dropoff_address:{formatted_address:formatted}, pickup_times:[0] };
    if (Number(orderValueCents)>0) payload.order_summary={currency_code:'BRL',order_value:Math.round(Number(orderValueCents))};
    const r = await fetch(`${uberApiBase}/v1/eats/deliveries/estimates`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const data = await r.json().catch(()=>({}));
    if (!r.ok) {
      const detail = data?.message || data?.code || `HTTP ${r.status}`;
      return res.status(r.status===401||r.status===403?502:502).json({error:`Uber Direct não autorizou a cotação (${detail}).`,providerStatus:r.status,providerCode:data?.code||null});
    }
    const estimate = data?.estimates?.[0];
    if (!data?.estimate_id || !estimate?.delivery_fee) return res.status(502).json({error:'Uber Direct não retornou uma cotação válida.'});
    const lines = Array.isArray(estimate.delivery_fee.line_items)?estimate.delivery_fee.line_items:[];
    const consumerFee = lines.filter(x=>x?.category==='DELIVERY').reduce((sum,x)=>sum+Number(x?.value||0),0) || Number(estimate.delivery_fee.total||0);
    const expiresAt = new Date(Number(data.expires_at||Date.now()+15*60*1000));
    await pool.query(`INSERT INTO delivery_quotes(estimate_id,fee_cents,currency_code,expires_at,provider,address) VALUES($1,$2,$3,$4,'UBER_DIRECT',$5) ON CONFLICT(estimate_id) DO UPDATE SET fee_cents=EXCLUDED.fee_cents,expires_at=EXCLUDED.expires_at,address=EXCLUDED.address`,[data.estimate_id,Math.round(consumerFee),estimate.delivery_fee.currency_code||'BRL',expiresAt,address]);
    res.json({provider:'UBER_DIRECT',estimateId:data.estimate_id,feeCents:Math.round(consumerFee),deliveryFee:Math.round(consumerFee)/100,currency:estimate.delivery_fee.currency_code||'BRL',expiresAt:expiresAt.toISOString(),etd:estimate.etd||null});
  } catch(e) {
    console.error('Delivery estimate error:',e);
    res.status(502).json({error:e.message||'Não foi possível calcular a entrega.'});
  }
});

app.post('/api/orders', async (req, res) => {
  const { customer, orderType, address, items, deliveryFeeCents = 0, deliveryEstimateId = null } = req.body || {};
  if (!customer?.name || !customer?.phone || !Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Dados do pedido incompletos.' });
  if (!['DELIVERY','PICKUP'].includes(orderType)) return res.status(400).json({ error: 'Tipo de pedido inválido.' });
  if (orderType === 'DELIVERY' && (!address?.cep || !address?.number)) return res.status(400).json({ error: 'Endereço incompleto.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let subtotal = 0; const locked = [];
    for (const item of items) {
      const r = await client.query('SELECT id,name,price_cents,stock,active FROM products WHERE id=$1 FOR UPDATE', [item.productId]);
      if (!r.rowCount || !r.rows[0].active) throw new Error('Produto indisponível.');
      const p = r.rows[0]; const qty = Number(item.quantity);
      if (!Number.isInteger(qty) || qty < 1 || p.stock < qty) throw new Error(`Estoque insuficiente para ${p.name}.`);
      subtotal += p.price_cents * qty; locked.push({ ...p, qty });
    }
    let fee = 0;
    let quote = null;
    if (orderType === 'DELIVERY') {
      if (!deliveryEstimateId) throw new Error('Calcule a taxa de entrega antes de continuar.');
      const qr = await client.query('SELECT * FROM delivery_quotes WHERE estimate_id=$1 FOR UPDATE',[deliveryEstimateId]);
      if (!qr.rowCount) throw new Error('A cotação de entrega não foi encontrada.');
      quote = qr.rows[0];
      if (new Date(quote.expires_at).getTime() <= Date.now()) throw new Error('A cotação de entrega expirou. Calcule novamente.');
      fee = Number(quote.fee_cents);
    }
    const total = subtotal + fee;
    const c = await client.query(`INSERT INTO customers(name,phone) VALUES($1,$2) ON CONFLICT(phone) DO UPDATE SET name=EXCLUDED.name,updated_at=NOW() RETURNING id`, [customer.name.trim(), customer.phone.trim()]);
    const customerId = c.rows[0].id;
    const o = await client.query(`INSERT INTO orders(status,payment_status,customer_id,customer_name,customer_phone,order_type,subtotal_cents,delivery_fee_cents,total_cents,address,delivery_estimate_id,delivery_estimate_expires_at) VALUES('PENDING_PAYMENT','PENDING',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [customerId,customer.name.trim(),customer.phone.trim(),orderType,subtotal,fee,total,orderType==='DELIVERY'?address:null,quote?.estimate_id||null,quote?.expires_at||null]);
    const orderId = o.rows[0].id;
    for (const p of locked) {
      await client.query(`INSERT INTO order_items(order_id,product_id,product_name,quantity,unit_price_cents,subtotal_cents) VALUES($1,$2,$3,$4,$5,$6)`, [orderId,p.id,p.name,p.qty,p.price_cents,p.price_cents*p.qty]);
      await client.query('UPDATE products SET stock=stock-$1,updated_at=NOW() WHERE id=$2',[p.qty,p.id]);
    }
    await client.query('COMMIT');
    res.status(201).json({ id: orderId, status: 'PENDING_PAYMENT', paymentStatus: 'PENDING', subtotal: moneyPayload(subtotal), deliveryFee: moneyPayload(fee), total: moneyPayload(total), deliveryEstimateId: quote?.estimate_id||null });
  } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ error: e.message || 'Não foi possível criar o pedido.' }); }
  finally { client.release(); }
});

app.post('/api/payments/infinitepay/checkout', async (req, res) => {
  const { orderId } = req.body || {};
  if (!orderId) return res.status(400).json({ error: 'orderId obrigatório.' });
  if (!process.env.INFINITEPAY_HANDLE) return res.status(503).json({ error: 'InfinitePay ainda não configurada no servidor.' });
  const { rows } = await pool.query(`SELECT o.*, COALESCE(json_agg(json_build_object('quantity',oi.quantity,'price',oi.unit_price_cents,'description',oi.product_name)) FILTER (WHERE oi.id IS NOT NULL),'[]') items FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id WHERE o.id=$1 GROUP BY o.id`, [orderId]);
  if (!rows.length) return res.status(404).json({ error: 'Pedido não encontrado.' });
  const o = rows[0]; if (o.payment_status === 'PAID') return res.status(409).json({ error: 'Pedido já pago.' });
  const items = [...o.items]; if (o.delivery_fee_cents > 0) items.push({ quantity: 1, price: o.delivery_fee_cents, description: 'Taxa de entrega' });
  const base = publicBase();
  const payload = { handle: process.env.INFINITEPAY_HANDLE.replace(/^\$/,''), order_nsu: String(o.id), redirect_url: `${base}/pagamento-concluido`, webhook_url: `${base}/api/webhooks/infinitepay`, items, customer: { name: o.customer_name, phone_number: o.customer_phone } };
  if (o.address) payload.address = o.address;
  const r = await fetch('https://api.checkout.infinitepay.io/links', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
  const data = await r.json(); if (!r.ok || !data.url) return res.status(502).json({ error: 'InfinitePay não gerou o checkout.', details: data });
  res.json({ url: data.url, orderId: o.id });
});

app.post('/api/webhooks/infinitepay', async (req, res) => {
  const body = req.body || {}; const orderId = String(body.order_nsu || '');
  if (!orderId) return res.status(400).json({ success:false, message:'Pedido não encontrado' });
  const client = await pool.connect();
  try { await client.query('BEGIN'); const r=await client.query('SELECT id,payment_status FROM orders WHERE id=$1 FOR UPDATE',[orderId]);
    if (!r.rowCount) { await client.query('ROLLBACK'); return res.status(400).json({success:false,message:'Pedido não encontrado'}); }
    if (r.rows[0].payment_status !== 'PAID') await client.query(`UPDATE orders SET payment_status='PAID',status='RECEIVED',payment_transaction_nsu=$1,payment_invoice_slug=$2,payment_receipt_url=$3,payment_method=$4,paid_at=NOW() WHERE id=$5`, [body.transaction_nsu||null,body.invoice_slug||null,body.receipt_url||null,body.capture_method||null,orderId]);
    await client.query('COMMIT'); res.status(200).json({success:true,message:null});
  } catch { await client.query('ROLLBACK'); res.status(500).json({success:false,message:'Erro interno'}); } finally { client.release(); }
});

app.get('/api/orders/:id', async (req,res)=>{ const {rows}=await pool.query(`SELECT o.*,COALESCE(json_agg(json_build_object('productId',oi.product_id,'name',oi.product_name,'quantity',oi.quantity,'unitPriceCents',oi.unit_price_cents)) FILTER (WHERE oi.id IS NOT NULL),'[]') items FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id WHERE o.id=$1 GROUP BY o.id`,[req.params.id]); if(!rows.length)return res.status(404).json({error:'Pedido não encontrado.'}); res.json(rows[0]); });
app.post('/api/orders/:id/request-delivery', async (req,res)=>{
  const { rows } = await pool.query(`SELECT o.*,COALESCE(json_agg(json_build_object('productId',oi.product_id,'name',oi.product_name,'quantity',oi.quantity,'unitPriceCents',oi.unit_price_cents)) FILTER (WHERE oi.id IS NOT NULL),'[]') items FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id WHERE o.id=$1 GROUP BY o.id`,[req.params.id]);
  if(!rows.length)return res.status(404).json({error:'Pedido não encontrado.'});
  const o=rows[0]; if(o.payment_status!=='PAID')return res.status(409).json({error:'O pedido ainda não está pago.'});
  if(o.order_type!=='DELIVERY')return res.status(400).json({error:'Este pedido é para retirada.'});
  if(!o.delivery_estimate_id)return res.status(409).json({error:'Pedido sem cotação de entrega.'});
  const mode=String(process.env.DELIVERY_QUOTE_MODE||'uber').toLowerCase();
  if(mode==='mock')return res.json({ok:true,provider:'MOCK',status:'DRIVER_ASSIGNED',trackingUrl:null});
  try{
    const token=await getUberAccessToken();
    const a=o.address||{};
    const orderItems=o.items.map(i=>({name:i.name,description:i.name,external_id:String(i.productId),quantity:i.quantity,price:Number(i.unitPriceCents),currency_code:'BRL'}));
    const payload={estimate_id:o.delivery_estimate_id,pickup_at:0,external_order_id:String(o.id),order_items:orderItems,order_summary:{currency_code:'BRL',order_value:Number(o.subtotal_cents)},order_value:Number(o.subtotal_cents),currency_code:'BRL',pickup:{store_id:process.env.UBER_DIRECT_STORE_ID},dropoff:{address:{formatted_address:deliveryAddressText(a),apt_floor_suite:a.complement||undefined},type:'DOOR',instructions:a.reference||'',contact:{first_name:o.customer_name,last_name:'',phone:o.customer_phone}},external_user_id:String(o.customer_id||o.customer_phone)};
    const r=await fetch(`${uberApiBase}/v1/eats/deliveries/orders`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const data=await r.json().catch(()=>({})); if(!r.ok)return res.status(502).json({error:`Uber Direct não criou a entrega (${data?.message||data?.code||r.status}).`});
    await pool.query(`UPDATE orders SET status='DELIVERY_REQUESTED',uber_delivery_order_id=$1,uber_tracking_url=$2 WHERE id=$3`,[data.order_id||null,data.order_tracking_url||null,o.id]);
    res.json({ok:true,provider:'UBER_DIRECT',status:'DELIVERY_REQUESTED',orderId:data.order_id,trackingUrl:data.order_tracking_url||null});
  }catch(e){console.error('Request delivery error:',e);res.status(502).json({error:e.message||'Não foi possível solicitar o entregador.'});}
});

app.post('/api/orders/:id/confirm-receipt', async (req,res)=>{ const r=await pool.query(`UPDATE orders SET status='DELIVERED',customer_confirmed_at=NOW(),delivered_at=NOW() WHERE id=$1 AND status='OUT_FOR_DELIVERY' AND payment_status='PAID' RETURNING id,status,customer_confirmed_at`,[req.params.id]); if(!r.rowCount)return res.status(409).json({error:'Pedido não está aguardando confirmação.'}); res.json(r.rows[0]); });
app.post('/api/orders/:id/review', async (req,res)=>{ const {stars=null,comment=''}=req.body||{}; if(stars!==null&&(!Number.isInteger(stars)||stars<1||stars>5))return res.status(400).json({error:'Nota inválida.'}); const order=await pool.query(`SELECT id,status,customer_confirmed_at FROM orders WHERE id=$1`,[req.params.id]); if(!order.rowCount||order.rows[0].status!=='DELIVERED'||!order.rows[0].customer_confirmed_at)return res.status(403).json({error:'Só é possível avaliar após confirmar o recebimento.'}); try{const r=await pool.query(`INSERT INTO reviews(order_id,stars,comment) VALUES($1,$2,$3) RETURNING *`,[req.params.id,stars,comment?.trim()||'']);res.status(201).json(r.rows[0]);}catch(e){if(e.code==='23505')return res.status(409).json({error:'Este pedido já foi avaliado.'});res.status(500).json({error:'Não foi possível salvar a avaliação.'});} });


// ---------- Gestor API ----------
app.get('/api/gestor/orders', async (_req,res)=>{
  const {rows}=await pool.query(`SELECT o.*,COALESCE(json_agg(json_build_object('productId',oi.product_id,'name',oi.product_name,'quantity',oi.quantity,'unitPriceCents',oi.unit_price_cents,'subtotalCents',oi.subtotal_cents)) FILTER (WHERE oi.id IS NOT NULL),'[]') items FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id GROUP BY o.id ORDER BY o.created_at DESC`);
  res.json(rows);
});
app.get('/api/gestor/products', async (_req,res)=>{
  const {rows}=await pool.query(`SELECT id,name,description,price_cents,category,photo_url,stock,active FROM products ORDER BY id`);
  res.json(rows.map(p=>({...p,price:p.price_cents/100})));
});
app.patch('/api/gestor/products/:id', async (req,res)=>{
  const {name,description,price,category,photo_url,active,stock}=req.body||{};
  const priceCents=price==null?null:Math.round(Number(price)*100);
  const {rows}=await pool.query(`UPDATE products SET name=COALESCE($1,name),description=COALESCE($2,description),price_cents=COALESCE($3,price_cents),category=COALESCE($4,category),photo_url=COALESCE($5,photo_url),active=COALESCE($6,active),stock=COALESCE($7,stock),updated_at=NOW() WHERE id=$8 RETURNING id,name,description,price_cents,category,photo_url,stock,active`,[name??null,description??null,priceCents,category??null,photo_url??null,active??null,stock==null?null:Math.max(0,Math.trunc(Number(stock))),req.params.id]);
  if(!rows.length)return res.status(404).json({error:'Produto não encontrado.'}); res.json({...rows[0],price:rows[0].price_cents/100});
});
app.post('/api/gestor/products', async (req,res)=>{
  const {name,description='',price,category='',photo_url='',stock=0,active=true}=req.body||{};
  if(!name||price==null)return res.status(400).json({error:'Nome e preço são obrigatórios.'});
  const {rows}=await pool.query(`INSERT INTO products(name,description,price_cents,category,photo_url,stock,active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[name.trim(),description,Math.round(Number(price)*100),category,photo_url,Math.max(0,Math.trunc(Number(stock))),Boolean(active)]);
  res.status(201).json({...rows[0],price:rows[0].price_cents/100});
});
app.patch('/api/gestor/orders/:id/status', async (req,res)=>{
  const allowed=['RECEIVED','ACCEPTED','PREPARING','READY','DELIVERY_REQUESTED','DRIVER_ASSIGNED','OUT_FOR_DELIVERY','DELIVERED','REJECTED'];
  const {status,reason=''}=req.body||{}; if(!allowed.includes(status))return res.status(400).json({error:'Status inválido.'});
  if(status==='DELIVERED')return res.status(403).json({error:'Pedido de entrega só pode ser finalizado pela confirmação do cliente.'});
  const {rows}=await pool.query(`UPDATE orders SET status=$1 WHERE id=$2 RETURNING id,status`,[status,req.params.id]);
  if(!rows.length)return res.status(404).json({error:'Pedido não encontrado.'}); res.json(rows[0]);
});
app.get('/api/gestor/customers', async (_req,res)=>{
  const {rows}=await pool.query(`SELECT c.id,c.name,c.phone,COUNT(o.id)::int orders,COALESCE(SUM(CASE WHEN o.payment_status='PAID' THEN o.total_cents ELSE 0 END),0)::int total_cents FROM customers c LEFT JOIN orders o ON o.customer_id=c.id GROUP BY c.id ORDER BY c.created_at DESC`); res.json(rows.map(x=>({...x,total:x.total_cents/100})));
});
app.get('/api/gestor/finance', async (_req,res)=>{
  const {rows}=await pool.query(`SELECT COALESCE(SUM(CASE WHEN payment_status='PAID' THEN total_cents ELSE 0 END),0)::int gross_cents,COUNT(*)::int orders,COALESCE(AVG(CASE WHEN payment_status='PAID' THEN total_cents END),0)::int avg_ticket_cents FROM orders`); res.json({...rows[0],gross:rows[0].gross_cents/100,avgTicket:rows[0].avg_ticket_cents/100});
});
app.get('/api/gestor/reviews', async (_req,res)=>{ const {rows}=await pool.query(`SELECT r.id,r.stars,r.comment,r.created_at,r.order_id FROM reviews r JOIN orders o ON o.id=r.order_id WHERE o.payment_status='PAID' AND o.customer_confirmed_at IS NOT NULL ORDER BY r.created_at DESC`); const rated=rows.filter(x=>x.stars); const average=rated.length?Number((rated.reduce((a,x)=>a+x.stars,0)/rated.length).toFixed(1)):null; res.json({average,total:rows.length,reviews:rows}); });

// ---------- Public legal pages for Meta and customers ----------
app.get('/politica-de-privacidade', (_req,res)=>res.sendFile(path.join(root,'public','politica-de-privacidade.html')));
app.get('/termos-de-servico', (_req,res)=>res.sendFile(path.join(root,'public','termos-de-servico.html')));
app.get('/exclusao-de-dados', (_req,res)=>res.sendFile(path.join(root,'public','exclusao-de-dados.html')));

app.use('/gestor', express.static(path.join(root,'gestor')));
app.use('/', express.static(path.join(root,'cliente')));
app.get('/pagamento-concluido', (_req,res)=>res.sendFile(path.join(root,'cliente','index.html')));

initDb().then(()=>app.listen(port,'0.0.0.0',()=>console.log(`Gel & El backend online na porta ${port}`))).catch(err=>{ console.error('Falha ao inicializar banco:',err); process.exit(1); });
