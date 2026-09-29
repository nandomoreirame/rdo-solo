# rdo-solo

Sessão SOLO no Red Dead Online (e GTA Online, que usa o mesmo netcode). O filtro
derruba as portas P2P do jogo para o Xbox, deixando o tráfego com os servidores
da Rockstar intacto, então a sessão continua viva mas ninguém consegue abrir
conexão direta com você.

O foco é ficar **sozinho**. A whitelist existe para deixar um ou outro amigo
entrar numa sessão solo, mas **não serve para jogar em bando de forma estável**:
veja "A whitelist não cria sessão com amigos" abaixo antes de contar com ela.

Substitui o "tic-tac" (o interruptor no cabo de rede): em vez de um pulso que
esvazia a sessão e deixa ela se repovoar em minutos, o bloqueio fica ligado e a
sessão permanece solo indefinidamente.

## Topologia

```
Xbox (192.168.1.250, IP manual)
  gateway 192.168.1.49   <- o homelab, não o modem
  DNS     192.168.1.49   <- Pi-hole no mesmo host
        |
homelab (192.168.1.49, eth0)
  encaminha, filtra as portas P2P, não faz NAT
        |
Vivo Box MitraStar (192.168.1.1)
  quem faz DHCP e roteia de verdade; o Deco está em modo Ponto de Acesso
        |
     internet
```

O tráfego de volta vem do modem direto para o console, sem passar pelo homelab.
Isso é de propósito: sem NAT, o tipo de NAT do Xbox não muda. A consequência é
que os redirecionamentos ICMP precisam ficar desligados, senão o kernel avisa o
console para falar direto com o modem e o filtro vira decoração.

O `.250` está fora da faixa do DHCP do modem (que vai de `.2` a `.200`), então
nunca colide com um lease.

## Os dois arquivos

| Arquivo | Onde roda | Papel |
|---|---|---|
| `workstation/rdo-solo` | workstation | o que você digita; leva o comando por SSH e roda sob `sudo` |
| `homelab/rdo-solo` | homelab (`/usr/local/bin/rdo-solo`) | quem mexe em iptables e rota |

Editar um não mexe no outro. Depois de alterar o do homelab, `rdo-solo deploy`.
O wrapper compara os md5 e avisa quando estão diferentes, porque o sintoma sem
esse aviso é um `usage:` cru que parece erro de digitação.

## Comandos

```
rdo-solo check              estado (único que não pede senha)
rdo-solo on | off           liga e desliga o bloqueio
rdo-solo watch [s]          monitor ao vivo do filtro
rdo-solo blocked [s]        quem foi barrado nos últimos N segundos
rdo-solo trace [s]          captura o tráfego e salva em ~/.cache/rdo-solo/
rdo-solo diag               por que o encaminhamento está sendo barrado
rdo-solo fix-route [off]    tira o console da tabela de rotas do Tailscale
rdo-solo console <ip>       aponta o filtro para outro IP
rdo-solo deploy             envia o script deste repo para o homelab
rdo-solo install | uninstall | nat-on | nat-off
```

Uso certo, resumido:

- **`on`** = ficar SOZINHO (grind de caça/coleta sem ninguém enchendo). Estável.
- **`off`** = jogar em BANDO. Missões, séries e confrontos já rodam numa
  instância privada só do seu bando; o filtro ligado é justamente o que derruba
  essas atividades com "falha de rede" (veja abaixo).

A whitelist (`allow`/`posse`) foi **removida em 28/09/2026**: numa sessão pública
ela não entrega Free Roam estável em bando (veja "A whitelist não cria sessão com
amigos") e o RDO não tem sessão privativa nativa no Xbox. O script é só solo.

### Log só de players (relays da Rockstar ocultos)

Os IPs da Rockstar batem na porta o tempo todo (relays de sessão) e poluíam o
`watch`/`blocked`. Desde 28/09/2026 a faixa **RSONET-NA1, `192.81.240.0/21`**
(192.81.240.0 a 192.81.247.255, todos os datacenters NA da Rockstar: SJC, EWR,
etc.) é **ocultada da exibição**. Importante: é **só cosmético**. Esses IPs
continuam caindo no `DROP` como todo o resto; eles apenas não aparecem no log, que
passa a mostrar só IP de player real. A faixa mora na variável `ROCKSTAR_RE` e
pode ser estendida no `/etc/rdo-solo.conf` (ex.: um datacenter fora da NA).

Como distinguir, se precisar conferir à mão: player tem PTR de provedor
residencial e dezenas/centenas de pacotes por intervalo; relay da Rockstar não
tem PTR reverso e manda 1-4 pacotes. Confira o dono de um IP com
`curl -s https://rdap.arin.net/registry/ip/<ip>` (nome começando com `RSG`/
`RSONET` é Rockstar).

### Bloquear os relays prejudica a conta?

Não, de nada conhecido ou reportado. Bloquear P2P é comportamento de rede, não uma
flag na conta: do lado da Rockstar é indistinguível de um NAT restrito ou internet
ruim. O que pune conta é manipulação de estado do jogo (dupe de item/dinheiro, mod
injetando conteúdo), que não é o caso aqui. Risco baixo, não zero, por ser área
cinza do ToS.

## Armadilhas que já morderam

**A whitelist não cria sessão com amigos (28/09/2026).** Foi o erro de projeto da
whitelist. Uma sessão do RDO é uma malha P2P com um HOST (um dos jogadores) e
relays de sessão da Rockstar por baixo; o jogo exige que você mantenha conexão
com o host e com essa espinha dorsal, não só com os amigos. A whitelist bloqueia
tudo nas portas P2P menos os amigos, então derruba o host (quase sempre um
estranho) e os relays. Como o RDO migra o host de tempos em tempos, a malha
aguenta alguns minutos e quebra na próxima migração para um peer bloqueado:
o jogo mostra "Você mudou de sessão devido a uma falha de rede" e te joga numa
sessão solo, matando a missão em bando. Não notei antes porque a captura do
`posse` acha os IPs dos amigos, mas nunca o host nem os relays. Consequência
prática: `on` só serve para ficar sozinho; para bando, `off`, e o conteúdo
estruturado (missões, séries, confrontos) já é instanciado só para o bando.
O RDO não tem sessão pública privativa nativa, e os contornos de PC (RDO Lobby
Manager, senha no STARTUP.META) são mods de arquivo que console não roda.

**Os IPs de relay da Rockstar: depende do uso.** O `192.81.241.0/24` (RSGEWR)
aparece na captura junto com os jogadores. Para sessão SOLO (bloquear tudo), pode
remover, você quer bloquear mesmo. Mas para tentar jogar acompanhado, esses
relays são parte da espinha dorsal e bloqueá-los é parte do que quebra a sessão.
Ou seja: o conselho "não libere os IPs da Rockstar" vale para solo, não é uma
regra universal.

**A tabela 52 do Tailscale engolia o tráfego do console (27/09/2026).** Sobrou da
tentativa de exit node: a tabela 52 ficou com `default dev tailscale0` e a regra
`ip rule 5270` manda todo pacote encaminhado para lá. O tráfego do Xbox era
entregue ao túnel, onde não havia exit node escutando, e morria. Ele nem chegava
ao `DOCKER-USER`, porque a chain `ts-forward` aceita qualquer coisa que saia pelo
`tailscale0` e `ACCEPT` encerra a travessia. O sintoma no console era
`0x50060190`, que parece problema da Rockstar. A correção é a `ip rule 5200`,
aplicada no `install` e no `boot`.

Diagnóstico de um minuto, quando o console ficar sem internet:

```
ip route get 203.0.113.1 from 192.168.1.250 iif eth0
```

Tem que responder `via 192.168.1.1 dev eth0`. Se responder
`dev tailscale0 table 52`, é isso de novo: `rdo-solo fix-route`.

**O IP do console fora de sincronia.** O filtro só morde o IP que está no
`/etc/rdo-solo.conf`. Se o console voltar para DHCP, todas as regras carregam e
não bloqueiam nada, reportando `ON` alegremente. Por isso o `on` se recusa a
rodar quando os dois IPs não batem.

**Contador de gate não é prova.** Regra ACCEPT com contador parado significa que
o tráfego não está passando por ali, mesmo que tudo pareça instalado.

**`set -e` e `[ teste ] && comando`.** Seis ocorrências no script derrubavam a
execução quando o teste era falso. A pior estava no `allow-add`: adicionar um IP
que já existia abortava antes do fim. Todas viraram `if`.

**Distinguir jogador de relay na captura.** Jogador de verdade vem com centenas de
pacotes por intervalo e PTR de provedor residencial. Os IPs da Rockstar aparecem
no bloco `192.81.241.0/24` (registro `RSGEWR`), sem PTR reverso e com meia dúzia
de pacotes. Para uma sessão solo, não precisa liberar os da Rockstar. Sobre
liberá-los ou não, veja a ressalva em "Os IPs de relay da Rockstar: depende do
uso" acima: a regra não é universal.

## Ideias, por ordem de impacto

> Nota (28/09/2026): as ideias 1 a 4 e a 7 giram em torno de liberar amigos numa
> sessão. Depois de "A whitelist não cria sessão com amigos", sabe-se que isso
> não entrega Free Roam estável em bando no Xbox. Elas seguem úteis só para o
> caso pontual de deixar alguém entrar numa sessão solo, não como caminho para
> uma sessão privativa. Priorize as defensivas (5, 6, 9).
>
> Nota (29/09/2026): o porte Rust (`tui/`) já entrega as defensivas 2
> (ntfy), 5 (tela de resumo ao encerrar), 9 (aviso de IPv6) e o vigia parcial da
> rota (6, só o aviso, não o reaplique automático). Novo lá: aba **jogadores na
> sessão** (os peers P2P da sessão quando o solo está desligado) e **GeoIP**
> (coluna "local" via MaxMind GeoLite2, ligada por `GEOIP_DB=`). Falta pela rede
> só o que é da camada de aplicação criptografada: gamertag/nome do jogador não
> saem do tráfego.

### 1. Liberar pelo celular

Página servida pelo Caddy que já roda no homelab, acessível por Tailscale,
listando quem bateu na porta nos últimos minutos com um botão de liberar ao lado
de cada endereço. Você joga no sofá e o notebook está longe; essa é a diferença
entre liberar um amigo em cinco segundos ou levantar.

Decisão pendente: página só de leitura com os comandos prontos para copiar, ou
com botões que agem de verdade. A segunda expõe uma ação privilegiada numa
página, ainda que só dentro da Tailscale.

### 2. Notificação quando alguém bate

Push no celular com o endereço, via ntfy. Casa com a ideia 1: chega a
notificação, você toca, cai na página, libera. Sem isso, só descobre que um amigo
tentou entrar quem está de olho no monitor.

### 3. O amigo que trocou de IP

Vai acontecer, porque conexão residencial é dinâmica, e o sintoma é confuso: um
entra e o outro não. `rdo-solo expect zeca 10m` deixaria o script vigiando por
dez minutos, e o primeiro endereço que insistisse em bater assumiria o lugar do
IP antigo do zeca. Resolve sem desligar o filtro nem refazer a captura.

### 4. Modo porteiro

`rdo-solo doorman 90`: mantém a porta aberta por noventa segundos, captura quem
entrar e tranca sozinho. É o `posse` sem cronometrar na mão, e funciona quando o
bando chega aos poucos em vez de todos de uma vez.

### 5. Resumo ao encerrar

O Ctrl+C no monitor imprime o retrato da sessão: duração, quantos endereços
distintos foram barrados, quem ficou e por quanto tempo.

### 6. Vigia da rota

Timer conferindo a `ip rule 5200` a cada poucos minutos e reaplicando se sumir.
Hoje ela é aplicada no boot, mas se o `tailscaled` reiniciar sozinho e refizer as
rotas dele, o Xbox perde a internet no meio do jogo com o mesmo `0x50060190` e
sem nenhuma pista. É a causa raiz da investigação de 27/09 voltando pela porta
dos fundos.

### 7. Validade na whitelist

Cada entrada com data, e um `rdo-solo allow --for 6h` para liberação temporária.
IP residencial antigo parado na lista é um estranho liberado esperando a hora,
porque aquele endereço já foi realocado para outra pessoa faz tempo.

### 8. Atalho no Niri

Ligar e desligar por keybind, como o `game-mode` faz no Super+Alt+G.

### 9. O ponto cego do IPv6

O filtro é IPv4. Se o Xbox tiver IPv6, o gateway dele é a ONT e não o homelab,
então esse tráfego passa longe do filtro e o P2P pode furar a sessão solo por
ali. O homelab não vê nenhum IPv6 do console, mas isso não prova nada: se
existisse, ele também não veria.

Verificação de verdade: Configurações > Rede > Configurações avançadas no Xbox.
Se aparecer um endereço IPv6, desligar o IPv6 no console fecha o buraco.

## Termos de uso

Manipular a própria rede para ficar sozinho numa sessão não é endossado pela
Rockstar. O relato consistente da comunidade é de risco baixo, mas não é zero.
Dentro da sessão solo ninguém é prejudicado; usar corte de rede em PvP para ficar
invulnerável enquanto mata os outros é outra coisa, e aí o prejuízo é de
terceiros.
