// Claude CLI 실행기 — 사용자 질문을 claude CLI에 넘겨 스킬을 자율 실행시킨다.
// cwd를 이 프로젝트 루트로 지정하므로 .claude/skills/의 rodaeri-loki 스킬이 자동 로드된다.
// claude가 질문을 보고 스킬이 필요한지 스스로 판단해 로그를 조회하고 답을 만든다.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 프로젝트 루트 (src/ 기준 한 단계 위). claude 실행 디렉토리 = 스킬 로드 기준. */
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

const CLAUDE_COMMAND = process.env.CLAUDE_COMMAND ?? 'claude';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? 'sonnet';
const DEFAULT_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? '600000'); // 10분

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

export interface RunClaudeOpts {
  timeoutMs?: number;
  /** claude가 읽도록 추가로 허용할 디렉토리(절대경로). --add-dir로 넘어간다. 이 화이트리스트 밖은 접근 불가. */
  extraDirs?: string[];
}

/**
 * claude CLI를 비대화형(--print)으로 실행한다. API 토큰 불필요 — CLI 자체 인증 사용.
 * extraDirs를 주면 --add-dir로 그 디렉토리들의 파일을 읽을 수 있게 허용한다(cwd는 스킬 로드용으로 유지).
 */
export function runClaude(prompt: string, opts: RunClaudeOpts = {}): Promise<ClaudeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // --add-dir는 <directories...> 가변인자라, 뒤에 오는 프롬프트 위치 인자까지 삼킨다.
  // 그래서 --add-dir 쌍들을 앞에 두고, 그 뒤에 값을 받는 --model을 둬서 가변인자를 끊은 다음
  // 마지막에 프롬프트를 놓는다. (--add-dir ... --model X <prompt> 순서라야 프롬프트가 안 먹힌다.)
  const addDirArgs = (opts.extraDirs ?? []).flatMap((d) => ['--add-dir', d]);
  return new Promise((resolve) => {
    const child = spawn(
      CLAUDE_COMMAND,
      ['--print', SKIP_PERMISSIONS_FLAG, ...addDirArgs, '--model', CLAUDE_MODEL, prompt + SLACK_FORMAT_INSTRUCTION],
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
      const minutes = Math.round(timeoutMs / 60000);
      // app.ts가 이 문자열을 사용자에게 그대로 보여준다. 실패 사실만 던지지 말고,
      // 왜 오래 걸렸는지와 다음에 어떻게 하면 좋은지를 친절히 안내한다.
      resolve({
        ok: false,
        output: stdout,
        error:
          `답변을 만드는 데 ${minutes}분을 넘겨서 중간에 멈췄어요. 조회 범위가 넓거나 여러 단계를 거치는 무거운 요청일 때 이렇게 됩니다.\n` +
          `이렇게 해보시면 도움이 돼요:\n` +
          `· 대상을 좁혀서 다시 요청해 주세요 (예: 기간·센터·건수를 줄이거나, 한 번에 한 가지만).\n` +
          `· 원하는 결과와 조건을 구체적으로 적어 주시면 한 번에 끝낼 확률이 올라가요 (예: "센터5, 가용재고>0, 상위 10건만").\n` +
          `· 정말 오래 걸리는 작업이면 잠시 후 다시 시도해 주세요.`,
      });
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: '', error: `claude 실행 실패: ${e.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true, output: stdout.trim(), error: '' });
      // stderr가 있으면 그대로 쓴다(원인이 명확). 비어 있으면(claude가 stderr 없이 죽는 일이 있다)
      // 사용자에겐 "종료 코드 1" 같은 기술 메시지 대신, 일시적 오류일 수 있으니 다시 시도하라고 안내한다.
      // 진짜 원인은 app.ts가 output과 함께 로그에 남긴다.
      const friendly =
        '요청을 처리하다 예기치 못하게 멈췄어요. 일시적인 문제일 수 있으니 잠시 후 다시 시도해 주세요.\n' +
        '계속 같은 증상이면 질문을 조금 더 구체적으로 바꿔서 보내 주시면 도움이 돼요.';
      resolve({ ok: false, output: stdout.trim(), error: stderr.trim() || friendly });
    });
  });
}
