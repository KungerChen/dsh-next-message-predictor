<div align="center">

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Русский](README.ru.md) · **Português**

</div>

<p align="center">
  <img src="icon.svg" width="88" alt="">
</p>

<h1 align="center">Previsão da próxima mensagem</h1>

<p align="center">
  <b>Um plugin para a caixa de entrada do DeepSeek Harness</b><br>
  Quando o assistente termina, a sua provável próxima mensagem já está esperando na caixa de entrada.<br>
  <kbd>Tab</kbd> insere, <kbd>Esc</kbd> ignora, e <b>nada é enviado por você</b>.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/vers%C3%A3o-0.4.1-4d6bfe" alt="versão 0.4.1">
  <img src="https://img.shields.io/badge/DeepSeek%20Harness-0.2.2--rc.1-1f2937" alt="DeepSeek Harness 0.2.2-rc.1">
  <img src="https://img.shields.io/badge/idiomas-9-8250df" alt="idiomas 9">
  <img src="https://img.shields.io/badge/depend%C3%AAncias%20externas-0-2ea44f" alt="dependências externas 0">
  <a href="https://github.com/KungerChen/dsh-next-message-predictor/actions/workflows/ci.yml"><img src="https://github.com/KungerChen/dsh-next-message-predictor/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/licen%C3%A7a-MIT-blue" alt="licença MIT">
</p>

<p align="center">
  <img src="docs/images/demo.png" width="760" alt="Demonstração: depois da resposta do assistente, uma sugestão cinza aparece na caixa de entrada; outra é pedida; Tab a insere">
</p>

<p align="center">
  <sub>Uma sugestão aparece → peça outra se não servir → <kbd>Tab</kbd> insere, e você ainda pode editar antes de enviar</sub>
</p>

---

## Por que usar

Ao trabalhar com um assistente, muitas respostas são curtas e fáceis de adivinhar: “continue”, “rode os testes”, “mostre as alterações”. Este plugin escreve essa continuação com antecedência e a deixa na caixa de entrada.

<table>
<tr>
<td width="33%" valign="top">

### ⌨️ Menos digitação

As continuações mais comuns a uma tecla de distância. Depois de inserido, o texto é como qualquer outro que você digitou: dá para editar e desfazer.

</td>
<td width="33%" valign="top">

### 🤫 Sem interrupções

Assim que você começa a digitar, a sugestão sai do caminho. Ela não aparece durante a composição do IME nem com um menu aberto. Quando o modelo não tem certeza, não oferece nada.

</td>
<td width="33%" valign="top">

### 🛡️ Nunca passa dos limites

Ele apenas coloca texto na caixa de entrada. Não existe nenhum código de “enviar mensagem” no plugin; enviar é sempre uma decisão sua.

</td>
</tr>
<tr>
<td valign="top">

### 💰 Custo sob controle

Por padrão, um modelo de baixo custo, com limites diários de pedidos e de tokens. Frases curtas que você repete são oferecidas diretamente, sem chamar o modelo.

</td>
<td valign="top">

### 🔒 Privacidade em primeiro lugar

Antes do envio, possíveis chaves, tokens, endereços de e-mail e números de telefone são ocultados. O navegador nunca envia o seu rascunho. As estatísticas locais guardam números, não texto.

</td>
<td valign="top">

### 📊 Uso transparente

Pedidos, taxa de aceitação, tempo de resposta e uso de tokens dos últimos 7 dias ficam na página de configurações, para você ver se vale a pena.

</td>
</tr>
</table>

## Recursos

### A sugestão fica na própria caixa de entrada

Quando o assistente termina, se a caixa de entrada estiver vazia, uma sugestão cinza aparece exatamente onde você ia digitar. Sem janelas pop-up e sem ocupar espaço.

<p align="center">
  <img src="docs/images/suggestion.png" width="720" alt="Uma sugestão cinza na caixa de entrada, com “Tab para aceitar” e “Outra” à direita">
</p>

| Tecla | O que faz |
|---|---|
| <kbd>Tab</kbd> ou <kbd>→</kbd> | Insere a sugestão na caixa de entrada, onde você pode continuar editando; <kbd>Ctrl</kbd>+<kbd>Z</kbd> desfaz apenas essa inserção |
| <kbd>Esc</kbd> | Oculta a sugestão |
| <kbd>Alt</kbd>+<kbd>\\</kbd> (configurável) | Faz a previsão na hora; com uma sugestão exibida, passa para outra. Uma única chamada traz várias alternativas, então a troca é instantânea |
| Simplesmente digitar | A sugestão some na hora; ela volta quando você esvazia a caixa de entrada |

### Três modos, um clique

Não quer estudar cada opção? Escolha um modo. Dá para desfazer ou ajustar depois.

<p align="center">
  <img src="docs/images/modes.png" width="720" alt="O cartão de modos: Equilibrado, Econômico, Qualidade">
</p>

| Modo | Quando prevê | Modelo | Contexto | Limite diário | Indicado para |
|---|---|---|---|---|---|
| **Equilibrado** (Recomendado) | Automaticamente após cada resposta | Um modelo específico de baixo custo | 12 mensagens | 200 pedidos | O uso diário |
| **Econômico** | Só quando você clica em “Prever” ou usa o atalho | Um modelo específico de baixo custo | 6 mensagens | 60 pedidos | Controle rigoroso de custos |
| **Qualidade** | Automaticamente após cada resposta | O modelo da sessão | 20 mensagens | 200 pedidos | Sugestões mais certeiras |

Um modo só altera o disparo, a estratégia de modelo, o tamanho do contexto e os limites. Ele não mexe no interruptor principal, no atalho, no idioma nem nas opções de privacidade, e mantém o modelo que você informou.

### Nove idiomas de interface

A página de configurações, os botões da caixa de entrada e as dicas deles estão disponíveis em 简体中文, English, 日本語, 한국어, Español, Français, Deutsch, Русский, Português. Por padrão, o plugin segue o idioma definido no DeepSeek Harness; você também pode escolher um em **Configurações → Previsão → Idioma**, e ele vale na hora. Já as sugestões seguem sempre o idioma da sua conversa.

<p align="center">
  <img src="docs/images/languages.png" width="720" alt="O topo da página de configurações em inglês, japonês, espanhol e russo">
</p>

### A um clique na barra lateral

Clique em “Adicionar à barra lateral” e um item aparece na barra lateral esquerda do DSH; depois disso, conferir o estado ou trocar de modo não exige mais passar pelas Configurações. A versão ao lado do título mostra sempre qual está instalada.

<table>
<tr>
<td width="30%" align="center" valign="middle">
  <img src="docs/images/sidebar-entry.png" width="230" alt="O item “Previsão” na barra lateral esquerda">
</td>
<td width="70%" align="center" valign="middle">
  <img src="docs/images/page-header.png" width="560" alt="A versão ao lado do título da página e o botão “Remover da barra lateral”">
</td>
</tr>
</table>

### Quanto você usa, num relance

<details>
<summary><b>Ver a página de configurações inteira</b> (básico, modos, origem das sugestões, modelo, últimos 7 dias)</summary>
<br>
<p align="center">
  <img src="docs/images/settings.png" width="640" alt="A página de configurações inteira">
</p>
</details>

> A maioria das capturas de tela mostra a interface em chinês. Elas vêm de uma conversa de demonstração e são geradas por um script deste repositório com um modelo simulado local; por isso o modelo aparece como Mock e os números são pequenos. No uso real, as sugestões vêm do modelo que você configurou no DSH.

## Instalação

Requer o DeepSeek Harness `0.2.2-rc.1` (`>=0.2.2-rc.1 <0.3.0`). O plugin não tem dependências externas nem precisa de compilação. Um comando instala:

```powershell
dsh plugin --profile desktop add github:KungerChen/dsh-next-message-predictor
```

O nome depois de `--profile` é o perfil que você usa no dia a dia: `desktop` no aplicativo para computador, `web` na versão web. Depois, **feche o DSH por completo e abra de novo**.

<details>
<summary>O comando <code>dsh</code> não é encontrado, ou você quer instalar a partir de uma pasta local</summary>

A linha de comando `dsh` fica na pasta de instalação do DeepSeek Harness e pode ser chamada pelo caminho completo. Para alterar o código por conta própria, clone o repositório e instale a partir da pasta local:

```powershell
git clone https://github.com/KungerChen/dsh-next-message-predictor.git
$dsh = '<pasta de instalação do DSH>\resources\runtime\cli\bin\dsh.cmd'
& $dsh plugin --profile desktop add '<pasta do plugin>'
```

`<pasta de instalação do DSH>` é onde o DeepSeek Harness está instalado; `<pasta do plugin>` é a pasta que você acabou de clonar.

</details>

Depois, três passos para começar:

1. Abra **Configurações → Previsão** e ligue “Ativar previsão”. Vem desligado: até você ativar, nenhuma sugestão é exibida e nenhum modelo é chamado.
2. Escolha um em “Modo”. O padrão é “Equilibrado”.
3. Para chegar mais rápido, clique em “Adicionar à barra lateral” no canto superior direito.

<details>
<summary>Atualizar e desinstalar</summary>

**Atualizar**: se você instalou pelo GitHub, desinstale e execute de novo o comando de instalação; se instalou de uma pasta local, execute `git pull` nela. Depois reinicie o DSH. Recarregar a página não basta: a página ficaria nova e a parte em segundo plano continuaria antiga, e a página de configurações avisaria que as versões não coincidem.

**Desinstalar**:

```powershell
dsh plugin --profile desktop remove dsh-next-message-predictor
```

Ative apenas um plugin de previsão para a caixa de entrada por perfil. Quando outro é detectado, este plugin se pausa sozinho e explica o motivo na página de configurações.

</details>

## O que ele envia

Cada previsão é um único pedido ao modelo, sem nova tentativa automática. Ele contém trechos das **mensagens do usuário e das respostas finais em texto do assistente** mais recentes da sessão atual: por padrão, no máximo 12 mensagens e cerca de 2.000 tokens.

- Não inclui argumentos nem saída de ferramentas, raciocínio ou o prompt do sistema.
- Antes do envio, possíveis chaves privadas, chaves de API, tokens, senhas, endereços de e-mail, números de celular e de identidade e o nome de usuário em caminhos da pasta pessoal são trocados por marcadores (baseado em regras; não há garantia de encontrar tudo).
- A página do navegador envia apenas identificadores de sessão e de turno, nunca o rascunho, anexos ou texto da conversa; o conteúdo destinado ao modelo é lido pela parte em segundo plano nos registros de sessão do próprio DSH.
- “Preferir mensagens curtas que você envia com frequência” apenas compara as mensagens curtas que você enviou neste computador; nenhum modelo é chamado.

A descrição completa, e como apagar os dados locais, está em [Privacidade e limites dos dados](docs/PRIVACY.md).

## Perguntas frequentes

<details>
<summary><b>Ele vai enviar uma mensagem por mim?</b></summary>

Não. Aceitar uma sugestão apenas coloca texto na caixa de entrada, pela interface de inserção da própria caixa; o plugin não contém nenhuma chamada que envie ou confirme.

</details>

<details>
<summary><b>Quanto custa?</b></summary>

Cada previsão é uma chamada bem curta ao modelo (por padrão, no máximo 96 tokens de saída). Os limites diários padrão são 200 pedidos e 500.000 tokens; atingidos, não há mais chamadas naquele dia. Para gastar menos, escolha o modo “Econômico”, que só prevê quando você pede. O uso real aparece em “Últimos 7 dias”, na página de configurações.

</details>

<details>
<summary><b>Por que às vezes não há sugestão?</b></summary>

É proposital: quando o modelo não tem certeza, não oferece nada, e a saída que foge às regras (longa demais, com várias linhas, no tom do assistente) é descartada. A linha de estado na página de configurações diz por que não há nenhuma agora. Quando quiser uma, pressione <kbd>Alt</kbd>+<kbd>\\</kbd>.

</details>

<details>
<summary><b>As sugestões são precisas?</b></summary>

Ele vai bem com continuações curtas e claras: confirmar, pedir uma verificação, perguntar um detalhe. Não consegue adivinhar o que só você sabe, e nesse caso o certo é ficar em silêncio.

</details>

## Documentação

A documentação detalhada está escrita em chinês.

| Documento | Conteúdo |
|---|---|
| [Guia de uso](docs/USER-GUIDE.md) | Teclas, cada item da página de configurações, modos, o item da barra lateral, perguntas frequentes |
| [Referência de configuração](docs/CONFIGURATION.md) | Valores padrão e intervalos de todas as opções, valores dos três modos |
| [Privacidade e limites dos dados](docs/PRIVACY.md) | O que é enviado, arquivos locais, como apagar os dados |
| [Arquitetura](docs/ARCHITECTURE.md) | As metades Host e navegador, o fluxo dos pedidos, o protocolo |
| [Desenvolvimento e verificação](docs/DEVELOPMENT.md) | Compilação, testes, verificação de ponta a ponta, como gerar as capturas de novo |
| [Compatibilidade](docs/COMPATIBILITY.md) | O contrato confirmado com o DSH 0.2.2-rc.1 e as alternativas |
| [Registro de alterações](CHANGELOG.md) | Mudanças de cada versão |
| [Índice da documentação](docs/README.md) | Todos os documentos, incluindo notas anteriores de verificação e otimização |

## Contribuir

```powershell
npm run build   # gera lib/client.js a partir de src/shared + src/client
npm test        # executa os testes unitários e de integração
npm run check   # compilação + testes + verificação de sintaxe
```

Não precisa de `npm install` nem de empacotador; é necessário o Node.js 22 ou mais recente. Para adicionar ou corrigir uma tradução, edite `src/client/locales/<idioma>.js`; os testes verificam que todos os idiomas têm as mesmas chaves.

## Limitações conhecidas

- Verificado apenas no DSH `0.2.2-rc.1`.
- Salvar uma configuração faz o host reiniciar a parte em segundo plano do plugin; uma previsão em andamento é cancelada.
- Várias janelas compartilham os resultados das previsões; ocultar uma sugestão em uma janela não é sincronizado com as outras em tempo real.
- A paleta de comandos e a caixa de diálogo de feedback são reconhecidas pelo foco e por características modais; um erro de detecção significa apenas uma sugestão a menos, nunca uma tecla capturada.

## Licença

Publicado sob a [licença MIT](LICENSE). A escolha dos pontos de extensão e a interação “sugestão cinza + Tab para aceitar + Esc para ocultar” foram inspiradas no `dsh-composer-prediction`, também sob licença MIT; nenhum código dele foi copiado. Veja [NOTICE](NOTICE).
