CORREÇÃO DE RECUSA E ESTORNO

Importante: a InfinitePay atualmente documenta o cancelamento de vendas pelo App/maquininha/navegador, mas a documentação pública do Checkout Integrado não oferece um endpoint de estorno automático para o nosso checkout.

Por segurança, esta versão NÃO finge que estornou.
Ao recusar um pedido já pago:
- o pedido é marcado como REJEITADO;
- fica marcado como ESTORNO PENDENTE;
- o Gestor avisa para fazer o cancelamento/estorno no App InfinitePay;
- o financeiro continua contabilizando a venda até o estorno ser realmente confirmado.
