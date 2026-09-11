# Gel & El — backend de produção

Este pacote é a base para colocar o sistema online com Node.js + Express + PostgreSQL e conectar a WhatsApp Cloud API e InfinitePay.

## Arquitetura
- `/` — cliente
- `/gestor` — gestor
- `/api/*` — API
- `/api/webhooks/whatsapp` — webhook oficial do WhatsApp
- `/api/webhooks/infinitepay` — webhook do InfinitePay
- `/api/health` — teste do servidor/banco

## Variáveis obrigatórias
DATABASE_URL
PUBLIC_BASE_URL
INFINITEPAY_HANDLE
WHATSAPP_ACCESS_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_VERIFY_TOKEN

## Deploy recomendado
Railway: crie um projeto, adicione PostgreSQL, conecte o repositório e gere um domínio público para o serviço. Configure as variáveis no painel. O servidor usa `process.env.PORT` e escuta em `0.0.0.0`.

Depois de obter o domínio público, o webhook da Meta será:
GET/POST https://SEU-DOMINIO/api/webhooks/whatsapp

O Verify Token é um segredo criado por nós e precisa ser exatamente o mesmo na Meta e no Railway.
