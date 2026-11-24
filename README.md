# Minhas Finanças — versão inicial

Abra via servidor HTTP local (python -m http.server 8000) ou GitHub Pages. Use Experimentar demonstração para testar sem configurar serviços. Dados de demonstração ficam no navegador; não use dados sensíveis nesse modo.

## Firebase (protótipo)
Crie projeto Firebase, habilite Authentication por e-mail/senha e Firestore. Copie a configuração pública do app web para config.js substituindo null. Publique firestore.rules e adicione o domínio do GitHub Pages aos domínios autorizados de Authentication.

ATENÇÃO: o índice de usuários desta versão permite consulta pontual pública do e-mail por nome de usuário. Não publique para usuários reais antes de substituir essa resolução por um endpoint autenticador protegido contra enumeração e abuso. Os documentos financeiros têm regras de acesso por UID. Não use chaves privadas no GitHub.

## PWA
Publique todos os arquivos na raiz do repositório e habilite Pages. Abra o endereço HTTPS e use a opção instalar/adicionar à tela inicial do navegador. O cache permite abrir a interface offline; sincronização offline online ainda não foi implementada.

## Limitações
Versão inicial não auditada: biometria/passkeys e lembretes automáticos em segundo plano exigem backend e não estão implementados. O botão de teste usa notificações locais. Cartões registram faturas diretamente, sem controle individual de compras. Edição de ocorrência altera valor daquela ocorrência, mas descrição, categoria, conta e tipo da série inteira. Exclusão remove a série inteira. Recorrência mensal limitada a 120 ocorrências. Backup é exportação, sem importação. Não há integração bancária automática. Saldo registrado considera saldo inicial e baixas. Não há proteção contra edições simultâneas em múltiplos dispositivos. Testar antes de uso real.
