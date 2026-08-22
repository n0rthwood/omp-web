#!/usr/bin/env bash
set -euo pipefail
HOST="${1:-joysort@172.30.3.24}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" 'cat ~/.omp/agent/config.yml' > "$DIR/config.yml"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" 'cat ~/.omp/agent/models.yml' > "$DIR/models.yml"

cat >> "$DIR/models.yml" <<'YAML'

  # --- appended by release/seeds/fetch-seeds.sh: fleet-standard providers ---
  # This expanded set (agent-plan, volcengine-plan, xai) is the new baseline
  # seed going forward — it supersedes any older host's current models.yml
  # snapshot; see docs/plans/2026-08-20-omp-web-release-pipeline.md, Design
  # decision 14 (structural, not byte-identical, .202 parity).
  agent-plan:
    baseUrl: https://ark.cn-beijing.volces.com/api/plan/v3
    api: openai-completions
    apiKey: AGENT_PLAN_API_KEY
    authHeader: true
    models:
      - id: ark-code-latest
        name: ark-code-latest
      - id: doubao-seed-2-0-code-preview-260215
        name: doubao-seed-2-0-code-preview-260215
        input: [text, image]
        contextWindow: 262144
        maxTokens: 4096
      - id: doubao-seed-2-0-lite-260215
        name: doubao-seed-2-0-lite-260215
        input: [text, image]
        contextWindow: 262144
        maxTokens: 4096
      - id: doubao-seed-2-0-mini-260215
        name: doubao-seed-2-0-mini-260215
        input: [text, image]
        contextWindow: 262144
        maxTokens: 4096
      - id: doubao-seed-2-0-pro-260215
        name: doubao-seed-2-0-pro-260215
        input: [text, image]
        contextWindow: 262144
        maxTokens: 4096
      - id: glm-5.1
        name: glm-5.1
      - id: glm-5.2
        name: glm-5.2
      - id: kimi-k2.6
        name: kimi-k2.6
      - id: kimi-k2.7-code
        name: kimi-k2.7-code
      - id: minimax-m2.7
        name: minimax-m2.7
      - id: minimax-m3
        name: minimax-m3
  volcengine-plan:
    baseUrl: https://ark.cn-beijing.volces.com/api/coding/v3
    api: openai-completions
    apiKey: VOLCENGINE_PLAN_API_KEY
    authHeader: true
    models:
      - id: ark-code-latest
        name: ark-code-latest
        input: [text, image]
        contextWindow: 256000
        maxTokens: 4096
      - id: doubao-seed-2.0-code
        name: doubao-seed-2.0-code
        input: [text, image]
        contextWindow: 256000
        maxTokens: 4096
      - id: doubao-seed-2.0-lite
        name: doubao-seed-2.0-lite
        input: [text, image]
        contextWindow: 256000
        maxTokens: 4096
      - id: doubao-seed-2.0-pro
        name: doubao-seed-2.0-pro
        input: [text, image]
        contextWindow: 256000
        maxTokens: 4096
      - id: doubao-seed-code
        name: doubao-seed-code
        input: [text, image]
        contextWindow: 256000
        maxTokens: 4096
      - id: glm-4.7
        name: glm-4.7
        input: [text]
        contextWindow: 200000
        maxTokens: 4096
      - id: glm-5.1
        name: glm-5.1
        input: [text]
        contextWindow: 200000
        maxTokens: 4096
      - id: kimi-k2.5
        name: kimi-k2.5
        input: [text, image]
        contextWindow: 256000
        maxTokens: 4096
      - id: kimi-k2.6
        name: kimi-k2.6
        input: [text, image]
        contextWindow: 256000
        maxTokens: 4096
      - id: minimax-m2.7
        name: minimax-m2.7
        input: [text]
        contextWindow: 200000
        maxTokens: 4096
  xai:
    baseUrl: https://api.x.ai/v1
    api: openai-completions
    apiKey: XAI_API_KEY
    authHeader: true
    models:
      - id: grok-code-fast-1
        name: grok-code-fast-1
YAML

echo "==> Wrote $DIR/config.yml and $DIR/models.yml"
