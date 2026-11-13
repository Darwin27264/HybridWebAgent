# Master Implementation Specification: Local System 1 + System 2 Web Orchestrator ("Ofln-Scout")

## 1. Executive Summary & Architectural Vision
Build a cross-platform (Windows & Linux), 100% offline-first desktop application and execution daemon that combines two distinct local AI paradigms:
1. **System 2 (Slow, Deliberative Compiler):** Uses a quantized local LLM via **Ollama** or **llama.cpp** (`qwen2.5:7b-instruct-q4_K_M` or `llama3.2:3b`) to translate natural language user goals into deterministic, type-safe System 1 execution schemas.
2. **System 1 (Fast, Non-Autoregressive Decision Engine):** Uses **`@receptron/laya`** (Convai Innovations' 421M ModernBERT-large Jev-compatible decision model running on **ONNX Runtime**) to evaluate DOM elements and make multi-question typed decisions (`choice`, `noul`, `score`) in a single forward pass without generating tokens.

---

## 2. Critical Upstream Engineering Constraints (`@receptron/laya` & Hardware)
All subagents **MUST** strictly adhere to the following verified upstream specifications from `receptron/laya` and `receptron/laya-onnx`:

1. **`answer_confidence` vs `confidence` Gating (CRITICAL):**
   * In `@receptron/laya`, `result.answers[key].confidence` on `choice` and `score` questions represents $1 - \text{normalized\_entropy}$, **not** the probability of the chosen answer.
   * To gate alerts and actions accurately across `choice`, `noul`, and `score`, you **MUST** inspect **`answer_confidence`** ($\max(p)$, calibrated via checkpoint temperatures in $[0.5, 5.0]$).
2. **Hard Token Boundaries ($512$ / $192$ Rule):**
   * **State Limit:** `max_len` is strictly **$512$ tokens** after the question header. String/Object states keep their start; Array states (conversations) keep their newest end. DOM extractors must sanitize and cap text snippets to $\le 450$ characters before calling `laya.systemOne()`.
   * **Question Header Limit:** Each question's options must fit within `head_max_len` (**$192$ tokens**), otherwise `systemOne()` throws an unhandled exception.
   * **Choice Cardinality:** Limit `choice` questions to $\le 20$ distinct options. Duplicate option labels throw an error.
3. **Hardware & Runtime Execution Strategy:**
   * Do **not** use Docker ROCm `/dev/kfd` passthrough on entry-level RDNA2 GPUs (e.g., AMD RX 6400 `gfx1034`), which causes kernel panics.
   * Run `@receptron/laya` via native Node.js ONNX Runtime (`onnxruntime-node` $\ge 1.23$). Provide an optional Python/ORT script to dynamically quantize the 1.7 GB FP32 `laya.onnx` bundle down to a **403 MB INT8 bundle** (`laya_int8.onnx`), which delivers a $\sim 2.4\times$ CPU speedup.
   * Call `await ensureBundle()` during setup/build so the weights are cached under `~/.cache` before starting the user loop.

---

## 3. Multi-Agent Parallel Execution Plan (DAG)

The Lead Orchestrator Agent should spawn **4 specialized subagents** after completing Phase 0.

```
[Phase 0: Lead Agent Scaffolds Monorepo & Shared IPC Contracts (src/shared/types.ts)]
       │
       ├──► Subagent A (Core Daemon, WebSocket Server & SQLite Persistence)
       │
       ├──► Subagent B (System 2 Ollama Compiler & System 1 @receptron/laya Engine)
       │
       ├──► Subagent C (Playwright Stealth DOM Extractor & Action Runner)
       │
       └──► Subagent D (Modern React + Tailwind v4 + Shadcn UI Desktop Client)
       │
[Phase 2: Lead Agent Integrates Modules, Wires Tauri v2 / Electron Shell & Runs E2E Smoke Tests]
```

### Phase 0: Shared Contract Lock (Lead Agent — Execute First)
Before spawning subagents, the Lead Agent must initialize the workspace and write `packages/shared/src/types.ts` so all subagents code against identical interfaces.

#### Monorepo File Tree
```text
ofln-scout/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── scripts/
│   ├── prewarm-laya.mjs          # Calls ensureBundle() from @receptron/laya
│   └── quantize-int8.py          # Optional FP32 (1.7GB) -> INT8 (403MB) ORT quantizer
├── packages/
│   ├── shared/
│   │   ├── package.json
│   │   └── src/
│   │       └── types.ts          # Locked IPC, WebSocket, Laya & Task contracts
│   ├── daemon/
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts          # Daemon entrypoint & WS broadcaster (Port 4040)
│   │       ├── db.ts             # better-sqlite3 local storage for tasks & alerts
│   │       ├── compiler.ts       # System 2 Ollama JSON schema compiler + validator
│   │       ├── layaEngine.ts     # System 1 @receptron/laya wrapper & batcher
│   │       └── browserRunner.ts  # Playwright DOM candidate extractor & action loop
│   └── desktop-ui/
│       ├── package.json
│       ├── index.html
│       ├── vite.config.ts
│       ├── src-tauri/            # Tauri v2 cross-platform Rust wrapper (Windows/Linux)
│       └── src/
│           ├── main.tsx
│           ├── App.tsx
│           ├── store/
│           │   └── useAgentStore.ts  # Zustand real-time state & WS connection
│           └── components/
│               ├── SidebarTaskBuilder.tsx
│               ├── SystemTwoSpecViewer.tsx
│               ├── TelemetryHeader.tsx
│               ├── LiveInferenceFeed.tsx
│               └── FlaggedAlertsDrawer.tsx
```

#### Shared Types Contract (`packages/shared/src/types.ts`)
```typescript
// packages/shared/src/types.ts

export type LayaPrimitiveType = 'choice' | 'noul' | 'score';

export interface LayaChoiceQuestion {
  type: 'choice';
  question: string;
  options: Record<string, string> | string[]; // Max 20 distinct options, <192 tokens total
}

export interface LayaNoulQuestion {
  type: 'noul';
  statement: string; // Yes/No proposition evaluated for P(true)
}

export interface LayaScoreQuestion {
  type: 'score';
  question: string;
  rubric: Record<number, string>; // Ordered rubric levels
}

export type LayaQuestionMap = Record<
  string,
  LayaChoiceQuestion | LayaNoulQuestion | LayaScoreQuestion
>;

export interface AlertRule {
  questionKey: string;
  operator: 'equals' | 'gte' | 'boolean_true';
  targetValue: string | number | boolean;
  minAnswerConfidence: number; // Must gate on answer_confidence (0.50 - 0.99)
}

export interface CompiledTaskSpec {
  id: string;
  name: string;
  userGoal: string;
  targetUrl: string;
  domSelector: string;
  pollIntervalMs: number;
  scrollStepPx: number;
  questions: LayaQuestionMap;
  alertRule: AlertRule;
  createdAt: number;
}

export interface InferenceTelemetryItem {
  id: string;
  taskId: string;
  timestamp: number;
  domSnippet: string;
  latencyMs: number;
  rawAnswers: Record<
    string,
    {
      answer: string | number | boolean;
      answer_confidence: number;
      confidence?: number;
      distribution?: Record<string, number>;
    }
  >;
  triggeredAlert: boolean;
}

export type WsClientToServerMessage =
  | { type: 'COMPILE_TASK'; payload: { userGoal: string; ollamaModel?: string } }
  | { type: 'START_TASK'; payload: { spec: CompiledTaskSpec } }
  | { type: 'STOP_TASK' }
  | { type: 'CLEAR_ALERTS' };

export type WsServerToClientMessage =
  | { type: 'DAEMON_STATUS'; payload: { isRunning: boolean; layaReady: boolean; activeTaskId: string | null } }
  | { type: 'COMPILATION_PROGRESS'; payload: { status: 'compiling' | 'ready' | 'error'; message: string; spec?: CompiledTaskSpec } }
  | { type: 'INFERENCE_EVENT'; payload: InferenceTelemetryItem }
  | { type: 'ALERT_MATCH'; payload: InferenceTelemetryItem };
```

---

## 4. Subagent Work Packages (Execute in Parallel)

### Subagent A: Core Daemon, WebSocket Bus & SQLite Storage
**Scope:** `packages/daemon/src/index.ts` and `packages/daemon/src/db.ts`
**Responsibilities:**
1. Initialize `better-sqlite3` (`scout_local.db`) with tables `tasks` (stores `CompiledTaskSpec` JSON) and `alerts` (stores matched `InferenceTelemetryItem` rows).
2. Host a resilient WebSocket server on `ws://127.0.0.1:4040` using `ws`.
3. Expose clean event hooks so Subagent B and Subagent C can emit `INFERENCE_EVENT` and `ALERT_MATCH` payloads at 30+ Hz without blocking the main event loop.
4. Implement graceful shutdown (`SIGINT`, `SIGTERM`) that closes any active Playwright browser instance and flushes SQLite WAL logs.

---

### Subagent B: Dual-Brain AI Engine (System 2 Compiler + System 1 Laya Wrapper)
**Scope:** `packages/daemon/src/compiler.ts`, `packages/daemon/src/layaEngine.ts`, and `scripts/prewarm-laya.mjs`
**Responsibilities:**

#### 1. System 2 Compiler (`compiler.ts`)
* Connect to local Ollama (`http://127.0.0.1:11434/api/generate`) using `qwen2.5:7b-instruct-q4_K_M` (configurable fallback to `llama3.2:3b`).
* Enforce JSON schema output (`format: "json"`).
* **Post-Compilation Sanitizer (Mandatory):**
  * Verify every question in `questions` has $\le 20$ distinct options and an estimated token length $< 160$ tokens (leaving safety margin below `head_max_len = 192`).
  * Ensure `alertRule.minAnswerConfidence` defaults to `0.80` if omitted.
  * Provide built-in selector presets for common targets (e.g., Hacker News `.athing`, Reddit `shreddit-post, .thing`, GitHub `.Box-row`, or generic `article, [role="article"], li`).

#### 2. System 1 Decision Engine (`layaEngine.ts`)
* Import `{ Laya, ensureBundle }` from `@receptron/laya`.
* Support loading from default Hugging Face cache or a local INT8 directory (`LAYA_MODEL_DIR`).
* Implement `evaluateDomBatch(stateText: string, spec: CompiledTaskSpec)`:
  ```typescript
  // Truncate state to guarantee <512 tokens
  const cleanState = stateText.replace(/\s+/g, ' ').trim().slice(0, 460);
  const t0 = performance.now();
  const response = await this.laya.systemOne(cleanState, spec.questions);
  const latencyMs = Number((performance.now() - t0).toFixed(1));

  // CRITICAL: Gate using answer_confidence (max(p)), NOT entropy confidence
  const targetAns = response.answers[spec.alertRule.questionKey];
  const ansConf = targetAns?.answer_confidence ?? 0;
  ```

---

### Subagent C: Playwright Stealth DOM Extractor & Action Loop
**Scope:** `packages/daemon/src/browserRunner.ts`
**Responsibilities:**
1. Launch headless Chromium via `playwright` with low-footprint flags (`--disable-gpu`, `--disable-dev-shm-usage`).
2. Navigate to `spec.targetUrl` and extract candidate elements matching `spec.domSelector`.
3. **Deduplication Filter:** Maintain an in-memory `LRUCache<string, boolean>` (max 2,000 SHA-1 text hashes) so already-evaluated DOM nodes on the page are skipped on subsequent scroll ticks.
4. For each new candidate element:
   * Extract visible text + primary anchor `href` into a compact JSON state `{ text: "...", link: "..." }` (serialized via `JSON.stringify` under 450 chars).
   * Pass to Subagent B's `layaEngine.evaluateDomBatch()`.
   * Emit `INFERENCE_EVENT` and, if triggered, `ALERT_MATCH`.
5. Execute smooth viewport scrolling (`page.mouse.wheel(0, spec.scrollStepPx)`) and wait `spec.pollIntervalMs` with abort-controller support so stopping a task responds in $< 100\text{ ms}$.

---

### Subagent D: Modern Cross-Platform UI (React 19 + Tailwind CSS v4 + Shadcn/Radix + Lucide)
**Scope:** `packages/desktop-ui/`
**Design System & Aesthetic Requirements:**
* **Theme:** High-contrast "Linear / Raycast / Vercel" Dark Obsidian palette:
  * App Canvas: `#090A0F` (`bg-zinc-950`)
  * Elevated Surface / Cards: `#12141C` (`bg-zinc-900/80` with `backdrop-blur-md` and `border-zinc-800/80`)
  * Primary Accent (System 1 Active / Fast Path): Electric Emerald (`#10B981` / `text-emerald-400`)
  * Secondary Accent (System 2 Compiler): Violet Indigo (`#8B5CF6` / `text-violet-400`)
  * Alert / Flagged Accent: Amber Gold (`#F59E0B` / `text-amber-400`)
* **Typography:** `Inter` or `Geist Sans` for UI labels; `JetBrains Mono` or `Geist Mono` (`tabular-nums`) for all latency metrics, probabilities, and JSON specs.
* **UI Libraries & Icons:**
  * **Icons:** `lucide-react` (`Zap`, `BrainCircuit`, `Radar`, `ShieldAlert`, `Play`, `Square`, `SlidersHorizontal`, `ExternalLink`, `CheckCircle2`, `Activity`).
  * **Animations:** `framer-motion` for smooth list insertions in the live decision feed and alert drawer.
  * **Charts:** `recharts` (sparkline in the header showing real-time System 1 forward-pass latency in ms and throughput in items/sec).
  * **Notifications:** `sonner` for non-intrusive toast notifications when a high-confidence match arrives.

#### Layout Architecture (3-Column Responsive Workbench)
1. **Top Telemetry Bar (`TelemetryHeader.tsx`):**
   * Connection pill (`Daemon Connected` / `Laya Warm`).
   * Live metric counters with `tabular-nums`:
     * **System 1 Pass Latency:** e.g., `18.4 ms` + mini sparkline.
     * **Evaluated States:** e.g., `1,420 DOM nodes`.
     * **Flagged Matches:** e.g., `12 Alerts`.
2. **Left Column — Task Studio & System 2 Compiler (`SidebarTaskBuilder.tsx` & `SystemTwoSpecViewer.tsx`):**
   * Natural language prompt box: *"Tell System 2 what you want to monitor..."*
   * Quick-start template pills (`HN Local AI Monitor`, `Reddit Keyword Scout`, `GitHub Issue Triager`).
   * **Interactive Spec Inspector:** Displays the compiled `@receptron/laya` typed questions (`choice`, `noul`, `score`) as clean visual badges, allowing the user to tweak the `minAnswerConfidence` slider ($50\% - 99\%$) or CSS selector before clicking **Launch System 1 Loop**.
3. **Center Column — Real-Time System 1 Decision Matrix (`LiveInferenceFeed.tsx`):**
   * Streams evaluated DOM snippets in real time.
   * Each card shows:
     * DOM snippet preview.
     * Probability distribution bar for `choice` options or calibrated `noul` gauge.
     * `answer_confidence` badge (`94.2%`) and execution time badge (`16.8ms`).
4. **Right Column — Flagged Matches & Action Drawer (`FlaggedAlertsDrawer.tsx`):**
   * Dedicated persistent feed of items that crossed `minAnswerConfidence`.
   * One-click button to open the source URL in the system browser, copy JSON payload, or export matches to Markdown/CSV.

---

## 5. Build, Integration & Verification Protocol (Lead Agent Phase 2)

Once Subagents A, B, C, and D complete their modules, the Lead Agent must execute the following verification checklist in order:

### Step 1: Workspace Installation & Laya Bundle Pre-Warm
```bash
pnpm install
npx playwright install chromium
node scripts/prewarm-laya.mjs
```
* **Verification Gate:** Confirm `~/.cache` (or local `./onnx` directory) contains `laya.onnx`, `laya.onnx.data`, `laya_config.json`, and `tokenizer/`.

### Step 2: Unit & Contract Verification
Run a headless smoke test verifying `@receptron/laya` evaluates a sample DOM state in one forward pass:
```bash
pnpm --filter @ofln-scout/daemon test:smoke
```
* **Verification Gate:** Confirm `result.answers[key].answer_confidence` is a valid float in $[0, 1]$ and execution latency is logged.

### Step 3: Full-Stack Dev Launch
Start both the daemon and the desktop UI concurrently:
```bash
pnpm dev
```
* **Verification Gate:**
  1. WebSocket connects on `ws://127.0.0.1:4040` and UI status indicator turns Emerald (`Laya Ready`).
  2. Submitting a natural language prompt triggers local Ollama System 2 compilation and populates the visual Spec Inspector within 3 seconds.
  3. Clicking **Launch System 1 Loop** streams live Playwright DOM evaluations into the center column with calibrated `answer_confidence` scores and flags matching items in the right column.