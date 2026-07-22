// Claude CLI 실행기 — 사용자 질문을 claude CLI에 넘겨 스킬을 자율 실행시킨다.
// cwd를 이 프로젝트 루트로 지정하므로 .claude/skills/의 rodaeri-loki 스킬이 자동 로드된다.
// claude가 질문을 보고 스킬이 필요한지 스스로 판단해 로그를 조회하고 답을 만든다.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 프로젝트 루트 (src/ 기준 한 단계 위). claude 실행 디렉토리 = 스킬 로드 기준. */
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

const CLAUDE_COMMAND = process.env.CLAUDE_COMMAND ?? 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'sonnet';
const DEFAULT_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? '300000'); // 5분

// 봇이 사람 확인 없이 스킬(Bash 등)을 실행하도록 권한 확인을 건너뛴다 (오더비 run_claude와 동일).
const SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

// slack-format 스킬을 트리거하는 한 줄. 세부 규칙(볼드·표·코드펜스 등)은 전부 스킬에 있으니 되풀이하지 않는다.
// 이 한 줄만 있어도 스킬이 매번 유효한 blocks JSON을 낸다(eval에서 100% 통과 확인). 스킬 미사용을 막는 안전장치다.
const SLACK_FORMAT_INSTRUCTION =
  '\n\n---\n사용자에게 보낼 최종 답변은 slack-format 스킬 규칙에 따라 Slack Block Kit JSON으로 출력해라.';

export interface ClaudeResult {
  ok: boolean;
  output: string;
  error: string;
}

/**
 * claude CLI를 비대화형(--print)으로 실행한다. API 토큰 불필요 — CLI 자체 인증 사용.
 */
export function runClaude(prompt: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const child = spawn(
      CLAUDE_COMMAND,
      ['--print', SKIP_PERMISSIONS_FLAG, '--model', CLAUDE_MODEL, prompt + SLACK_FORMAT_INSTRUCTION],
      // stdin을 'ignore'로 닫는다. 안 그러면 claude CLI가 파이프 환경에서 stdin 입력을 기다리다
      // "no stdin data received" 경고를 내고 그게 출력에 섞여 실패로 처리된다(프롬프트는 인자로 넘긴다).
      { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, output: stdout, error: `타임아웃 (${timeoutMs}ms 초과)` });
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: '', error: `claude 실행 실패: ${e.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, output: stdout.trim(), error: '' });
      else resolve({ ok: false, output: stdout.trim(), error: stderr.trim() || `종료 코드 ${code}` });
    });
  });
}
