# Plan: Painel responsivo (controles no centro, info à direita/drawer)

> **Spec:** docs/specs/panel-layout/SPEC.md

**Goal:** Deixar só os controles no centro (estado por cor/borda, sem rótulos redundantes) e mover as informações gerais para um painel à direita (desktop/tablet) ou um drawer (mobile), com o "modo limpo" virando o toggle do painel.
**Architecture:** Só apresentação em `web/src/app/page.tsx` + `web/src/app/globals.css`. Um único bloco de info (`<aside>`) alternado por CSS: coluna à direita ≥900px, drawer <900px, controlado por um estado `panelOpen` persistido em localStorage. Sem libs novas, sem mudar API/dados.
**Tech Stack:** Next.js 15 (App Router, Client Component) + CSS + vitest.
**Total Tasks:** 4 (P1) + notas P2 embutidas
**Estimated Complexity:** small-medium (4 tasks)

**Commit:** cada task fecha em `/git commit` (skill `git-commit`, emoji + Conventional Commits em inglês). NUNCA push.
**Dependência:** 1 → 2 → 3 → 4 (em cadeia; 2 usa o helper da 1; 3 estiliza o que a 2 estrutura; 4 valida tudo).
**Gate web:** este projeto NÃO usa eslint/prettier — o gate é `./node_modules/.bin/tsc --noEmit` + `./node_modules/.bin/vitest run` + `./node_modules/.bin/next build`. Rodar de `web/` com os bins locais.

---

### Task 1: Helper puro `panelState.ts` (persistência do painel) + testes

**Requirement:** REQ-007
**Files:**
- Create: `web/src/lib/panelState.ts`
- Test: `web/src/lib/panelState.test.ts`

**Team:**
- Track: frontend
- Implementer: frontend-engineer (skills: `nextjs-fsd-conventions`, `test-driven-development`)
- Reviewers: type-safety-reviewer, test-reviewer

**Step 1 — teste que falha** (`web/src/lib/panelState.test.ts`):
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { readPanelOpen, writePanelOpen, PANEL_KEY } from "./panelState";

describe("panelState", () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* jsdom */ }
  });
  it("defaults to true when nothing stored", () => {
    expect(readPanelOpen(true)).toBe(true);
    expect(readPanelOpen(false)).toBe(false); // default param respected
  });
  it("roundtrips the stored value", () => {
    writePanelOpen(false);
    expect(readPanelOpen(true)).toBe(false);
    writePanelOpen(true);
    expect(readPanelOpen(false)).toBe(true);
  });
  it("uses a stable key", () => {
    expect(PANEL_KEY).toBe("rdo_panel_open");
  });
});
```
(vitest usa jsdom neste projeto; se não houver `localStorage`, os try/catch mantêm o teste verde no ambiente.)

**Step 2:** `cd web && ./node_modules/.bin/vitest run src/lib/panelState.test.ts` → FAIL.

**Step 3 — implementação** (`web/src/lib/panelState.ts`):
```ts
export const PANEL_KEY = "rdo_panel_open";

/** Last persisted panel-open preference, or `fallback` when unavailable. */
export function readPanelOpen(fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(PANEL_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

export function writePanelOpen(open: boolean): void {
  try {
    localStorage.setItem(PANEL_KEY, open ? "1" : "0");
  } catch {
    /* private mode / blocked storage: ignore */
  }
}
```

**Step 4:** `cd web && ./node_modules/.bin/vitest run src/lib/panelState.test.ts` → PASS; `./node_modules/.bin/tsc --noEmit` limpo.

**Step 5:** `/git commit`

---

### Task 2: `page.tsx` — tirar rótulos, uptime discreto, info em `<aside>` + toggle do painel

**Requirement:** REQ-001, REQ-002, REQ-003, REQ-006, REQ-009, REQ-010
**Files:**
- Modify: `web/src/app/page.tsx` (render; remover bloco de rótulo `:356-366`; `squad-controls` `:379`; bloco `{!clean && ...}` `:412-490`; estado `clean` `:28`)
- Test: cobertura via Task 1 + visual na Task 4

**Team:**
- Track: frontend
- Implementer: frontend-engineer (skills: `frontend-design`, `nextjs-fsd-conventions`)
- Reviewers: type-safety-reviewer, test-reviewer, accessibility-guardrails

**Step 3 — implementação (apresentação):**
1. **Estado do painel:** substituir o estado `clean` por `panelOpen` usando o helper da Task 1:
   ```ts
   import { readPanelOpen, writePanelOpen } from "@/lib/panelState";
   const [panelOpen, setPanelOpen] = useState(true);
   useEffect(() => { setPanelOpen(readPanelOpen(true)); }, []);
   function togglePanel() {
     setPanelOpen((v) => { const n = !v; writePanelOpen(n); return n; });
   }
   ```
2. **Remover rótulos redundantes (REQ-001):** apagar o bloco que renderiza "SOLO ATIVO/SQUAD ATIVO/SOLO INATIVO" + "jogando normalmente"/"há X" (`page.tsx:356-366` region, a `<div>` de status textual). Manter o `solo-frame` (borda) e as classes de cor do card/botão.
3. **Uptime/sozinho discreto (REQ-002):** sob os botões de controle, uma linha pequena:
   ```tsx
   <p className="ctl-meta">
     {mode === "solo" || squadActive
       ? `há ${uptime}`
       : status?.alone_ms != null
         ? `sozinho ${formatUptime(status.alone_ms)}`
         : " "}
   </p>
   ```
4. **Estrutura em zonas (REQ-003/004/005):** o `<main className="wrap">` passa a conter:
   - `<header className="brand">` (cabeçalho, como hoje) + o `solo-frame`.
   - `<section className="controls">` — SÓ os controles: botão Solo (`:346`), a `.ctl-meta`, as `squad-controls` (MODO SQUAD + Capturar, `:379-410`), os avisos (`squad-msg`/`squad-warn`). Centralizada.
   - `<aside className="panel" data-open={panelOpen} role="dialog" aria-label="Informações" aria-hidden={!panelOpen}>` — o bloco de info que hoje está em `{!clean && ...}` (squad salvo, métricas, peers, health), SEM o wrapper `{!clean}`.
   - `<div className="panel-backdrop" hidden={!panelOpen} onClick={togglePanel} />` (fecha o drawer no mobile ao tocar fora).
5. **Toggle do painel (REQ-006):** o antigo link "modo limpo" vira o botão do painel:
   ```tsx
   <button type="button" className="panel-toggle" aria-expanded={panelOpen}
     aria-controls="panel" onClick={togglePanel}>
     {panelOpen ? "ocultar painel" : "painel"}
   </button>
   ```
   (dê `id="panel"` ao `<aside>`.) No desktop recolhe a coluna; no mobile abre/fecha o drawer — a diferença é só CSS (Task 3).
6. **Esc fecha o drawer (REQ-010):**
   ```ts
   useEffect(() => {
     function onKey(e: KeyboardEvent) { if (e.key === "Escape" && panelOpen) togglePanel(); }
     window.addEventListener("keydown", onKey);
     return () => window.removeEventListener("keydown", onKey);
   }, [panelOpen]);
   ```
7. **A11y:** `aria-expanded`/`aria-controls` no toggle; `role="dialog"`/`aria-hidden` no aside; manter foco visível (classes existentes). Não remover as cores de estado (REQ-008) nem o "ao vivo" (REQ-009).

**Step 4:** `cd web && ./node_modules/.bin/tsc --noEmit` limpo; `./node_modules/.bin/vitest run` verde (nada quebrado).

**Step 5:** `/git commit`

---

### Task 3: `globals.css` — grid (controles | painel) + drawer no mobile

**Requirement:** REQ-004, REQ-005, REQ-006, REQ-010, REQ-011
**Files:**
- Modify: `web/src/app/globals.css`
- Test: visual na Task 4

**Team:**
- Track: frontend
- Implementer: frontend-engineer (skills: `frontend-design`)
- Reviewers: accessibility-guardrails, type-safety-reviewer

**Step 3 — estilos:**
1. **Base / mobile (<900px):** `.wrap` continua coluna; `.controls` centralizado (max-width ~460px, `margin-inline: auto`). O `.panel` vira **drawer**:
   ```css
   .panel {
     position: fixed; inset: 0 0 0 auto; width: min(88vw, 360px);
     overflow-y: auto; padding: 16px;
     transform: translateX(100%); transition: transform .22s ease;
     background: var(--panel-bg, #11151c); z-index: 60;
   }
   .panel[data-open="true"] { transform: translateX(0); }
   .panel-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 55; }
   .panel-toggle { /* botão visível para abrir o drawer */ }
   ```
2. **Desktop/tablet (≥900px):** duas colunas, o drawer vira coluna estática à direita e o backdrop some:
   ```css
   @media (min-width: 900px) {
     .wrap { display: grid; grid-template-columns: minmax(0,1fr) 340px; gap: 20px; align-items: start; }
     .brand { grid-column: 1 / -1; }
     .controls { grid-column: 1; justify-self: center; align-self: center; }
     .panel {
       position: static; width: auto; transform: none; inset: auto;
       grid-column: 2; z-index: auto; background: transparent; padding: 0;
     }
     .panel[data-open="false"] { display: none; }           /* "ocultar painel" recolhe a coluna */
     .wrap:has(.panel[data-open="false"]) { grid-template-columns: 1fr; } /* controles ocupam tudo */
     .panel-backdrop { display: none; }
   }
   ```
   (se o alvo não suportar `:has`, fallback: manter 340px vazio quando recolhido — aceitável.)
3. **Transições e foco:** `prefers-reduced-motion` zera a transição; manter `:focus-visible` nos botões; o `.panel-toggle` com área de toque ≥40px.
4. Mover/renomear as regras do antigo `.clean-toggle` para `.panel-toggle`; remover estilos órfãos do rótulo de estado removido (ex. a classe do "SOLO ATIVO").

**Step 4:** `cd web && ./node_modules/.bin/next build` compila; abrir e conferir na Task 4.

**Step 5:** `/git commit`

---

### Task 4: Validação (tsc + build) + checklist visual + deploy

**Requirement:** REQ-004, REQ-005, REQ-010, REQ-011
**Files:** — (validação/ops)

**Team:**
- Track: infra
- Implementer: infra-engineer (skills: `bash-linux`)
- Reviewers: accessibility-guardrails

**Passos:**
1. `cd web && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run && ./node_modules/.bin/next build` — tudo limpo.
2. **Checklist visual** (responsivo):
   - **Desktop ≥900px:** controles centralizados à esquerda, painel de info à direita; "ocultar painel" recolhe a coluna e os controles ocupam a largura.
   - **Mobile <900px:** só os botões ao centro; botão "painel" abre o drawer deslizando da direita; fecha tocando no backdrop, no X e com **Esc**; foco visível.
   - Estado solo/squad: borda + cor do botão indicam (sem os rótulos removidos); uptime/sozinho discreto sob os botões.
   - Estados vazios (sem peers, squad vazio) e muitos peers (scroll no painel).
3. **Deploy** (quando aprovado): `./deploy.sh --web-only` (rsync + rebuild do container). Hard refresh no navegador pra pegar o bundle novo.

**Nota:** sem TDD aqui (é validação). O único teste de unidade do plano é o da Task 1.

---

## Follow-up (P3)
- **REQ-012** — lembrar scroll/aba do painel (persistir a posição do scroll do `.panel`).
