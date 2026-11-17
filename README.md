# HybridWebAgent 🚀

[![CI / Tests](https://img.shields.io/badge/Tests-436%20Passing-10B981?style=flat-square)](tests/e2e)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![Offline AI](https://img.shields.io/badge/Offline%20AI-Zero%20Cloud%20APIs-8B5CF6?style=flat-square)](https://github.com/Darwin27264/HybridWebAgent)

**HybridWebAgent** is an autonomous, offline-first dual-brain web agent designed for intelligent web scouting, structured data extraction, and interactive page navigation. 

By combining a **fast-path non-autoregressive ONNX classifier (System 1)** with an **in-process embedded llama.cpp LLM reasoner (System 2)**, HybridWebAgent achieves high-frequency DOM evaluation (10–30+ Hz) while retaining high-level goal reasoning, interactive form filling, and real-time human steering—**100% locally with zero cloud API keys or external server dependencies**.

---

## 🧠 Dual-Brain Architecture

```
                   ┌──────────────────────────────────────────────┐
                   │           Natural Language Goal              │
                   └──────────────────────┬───────────────────────┘
                                          │
                                          ▼
                   ┌──────────────────────────────────────────────┐
                   │    System 2: Strategic Reasoning Engine      │
                   │  (In-Process node-llama-cpp • Vulkan GPU)    │
                   └──────────────┬───────────────────────────────┘
                                  │ Compiles Task Specification
                                  ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                      System 1: Fast Execution Loop                          │
 │                    (Playwright Chromium + ONNX Engine)                      │
 │                                                                             │
 │   ┌──────────────────────┐                 ┌───────────────────────────┐    │
 │   │  DOM Element Stream  ├────────────────►│ Non-Autoregressive ONNX   │    │
 │   │  (Selectors, Scroll) │                 │ Classifier (10–30+ Hz)    │    │
 │   └──────────┬───────────┘                 └─────────────┬─────────────┘    │
 │              │                                           │                  │
 │              │ Handover on Stagnation / Input Forms      │ Alert Filter     │
 │              ▼                                           ▼                  │
 │   ┌──────────────────────┐                 ┌───────────────────────────┐    │
 │   │ System 2 Navigator   │◄────────────────┤ SQLite WAL State & Cache  │    │
 │   │ (Interactive Forms,  │  Prompts for    │ (Resumable Checkpoints)   │    │
 │   │  Forks, Pagination)  │  Guidance       └─────────────┬─────────────┘    │
 │   └──────────────────────┘                               │                  │
 └──────────────────────────────────────────────────────────┼──────────────────┘
                                                            ▼
                   ┌──────────────────────────────────────────────┐
                   │         Interactive Results & Steering       │
                   │     (Narrative Summary • Q&A • Live Re-run)  │
                   └──────────────────────────────────────────────┘
```

### System 1: The Fast-Path Visual & DOM Engine
- **Non-Autoregressive Forward Passes**: Runs `@receptron/laya` / ModernBERT on ONNX Runtime CPU / DirectML.
- **Microsecond Decisions**: Evaluates elements in parallel against multi-question rubrics (choice, noul, score) at up to 30+ evaluations per second.
- **Autonomous Navigation**: Executes scroll progression, detects page loops, extracts targeted DOM nodes, and flags high-confidence alert matches.

### System 2: The Deliberative LLM Reasoner
- **Embedded In-Process llama.cpp**: Powered by `node-llama-cpp` v3.22 with Vulkan GPU offload (Intel Arc B580 / NVIDIA / AMD) — **no separate Ollama daemon required**.
- **Automated Task Compiler**: Translates high-level natural language objectives into executable System 1 task specs with calibrated confidence gates.
- **Collaborative Deliberation**: System 1 hands off to System 2 when encountering search inputs, login/filter forms, navigation forks, or page stagnation.
- **Interactive Conversational Steering**: Converse directly with the loaded System 2 model via chat to query findings or steer the running crawler in real time.

---

## ✨ Key Features

- **🛡️ 100% Local & Privacy-Preserving**: No API keys, no telemetry tracking, zero monthly SaaS costs, and zero cloud data leaks.
- **💾 SQLite WAL Resumable Checkpointing**: Full transactional checkpointing (`better-sqlite3` in WAL mode). If interrupted, resume immediately from the exact page and step.
- **📦 Embedded Model Hub**: Download GGUF models directly from Hugging Face with live progress and cancel support, or bring your own custom quantized models.
- **🖥️ Wide-Screen Desktop Interface**: Clean dark-gray interface (React 19 + Tailwind CSS) optimized for 1080p, 1440p, 4K, and ultrawide viewports.
- **🔄 4-Stage Sequential Wizard**:
  1. **Goal & Model Setup**: Natural language goal formulation, quick presets, and GGUF model manager.
  2. **Spec Inspector**: URL, DOM selector, alert threshold calibration slider, and compiled question review.
  3. **Live Execution**: 1 Hz live Playwright browser viewport, action trajectory timeline, and non-autoregressive inference stream.
  4. **Results & Steering**: Scraped items data table, Markdown and CSV export, System 2 narrative synthesis, and interactive steering console.
- **🧪 Production-Grade Test Suite**: 225 unit/integration tests and 436 multi-tier E2E tests verifying collaborative browsing, resumption RPC, and stress boundary conditions.

---

## 📂 Monorepo Structure

```
HybridWebAgent/
├── packages/
│   ├── shared/            # TypeScript contracts, interfaces, and WebSocket RPC schemas
│   ├── daemon/            # Playwright browser runner, ONNX classifier, node-llama-cpp, SQLite DB
│   └── desktop-ui/        # React 19 + Vite + Tailwind CSS desktop workbench
├── tests/
│   └── e2e/               # 4-tier E2E testing harness (436 automated tests)
├── scripts/               # Launch utilities, pre-warming, and quantization tools
├── package.json           # PNPM workspace root configuration
└── pnpm-workspace.yaml    # Monorepo package definitions
```

---

## ⚡ Quickstart

### Prerequisites
- **Node.js**: v20.0.0 or higher (v22+ recommended)
- **PNPM**: v9.0.0 or higher (`corepack enable && corepack prepare pnpm@latest --activate`)
- **Vulkan / GPU Drivers**: (Optional but recommended for GPU acceleration on Intel Arc, NVIDIA, or AMD)

### 1. Clone & Install
```bash
git clone https://github.com/Darwin27264/HybridWebAgent.git
cd HybridWebAgent
pnpm install
```

### 2. Build Workspaces
```bash
pnpm -r build
```

### 3. Launch Development Workbench
```bash
# Start both the backend daemon (WebSocket port 4040) and desktop UI (Vite port 5173)
pnpm dev
```

Alternatively, use the convenience launcher scripts for your platform:
- **Windows (PowerShell)**: `.\launch.ps1`
- **Windows (CMD)**: `launch.bat`
- **Linux / macOS**: `./launch.sh`

Open your browser to `http://localhost:5173` to access the Scout Workbench.

---

## 🧪 Testing & Verification

HybridWebAgent features an exhaustive test suite covering unit contracts, daemon lifecycle, model transitions, and end-to-end integration:

```bash
# Run all unit, integration, and E2E test suites
pnpm test

# Run TypeScript typechecks across all workspace packages
pnpm -r typecheck

# Run Playwright and multi-tier browser enhancement test suites
pnpm test:e2e
```

---

## ⚙️ Hardware Acceleration Ladder

| Subsystem | Primary Provider | Fallback Provider | Fallback 2 |
| :--- | :--- | :--- | :--- |
| **System 1 (ONNX Fast-Path)** | DirectML (`DmlExecutionProvider`) | CPU (`CpuExecutionProvider`) | FP32 Software Fallback |
| **System 2 (Llama.cpp LLM)** | Vulkan GPU Offload (VRAM) | CPU Offload | Deterministic Keyword Engine |

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).
