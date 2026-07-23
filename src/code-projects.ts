// 로대리가 질문에 답할 때 참고할 사내 프로젝트 소스코드 목록.
// code-projects.json(개인 PC 절대경로가 담겨 .gitignore로 제외)에서 읽는다.
// claude가 질문을 보고 어떤 프로젝트가 관련되는지 스스로 판단하므로, 여기선
// "어떤 프로젝트를 참고 대상으로 둘지"와 "각 프로젝트가 뭔지"(설명)만 관리한다.
//
// 이 경로들은 executor에서 --add-dir로 넘어가 접근이 열린다. 다만 봇은 claude를
// --dangerously-skip-permissions로 돌리므로, 이 목록은 접근을 물리적으로 가두는
// 화이트리스트가 아니라 "관련 프로젝트에 집중하라"는 유도용이다. 목록 밖 경로도
// 원리상 읽을 수 있으니, 민감 경로를 봇이 닿는 곳에 두지 않는 선에서 쓴다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url));

export interface CodeProject {
  name: string;
  path: string;
  description: string;
}

/**
 * code-projects.json을 읽어, 실제로 존재하는 디렉토리만 돌려준다.
 * 경로 오타나 아직 클론 안 한 프로젝트가 섞여 있어도 봇이 죽지 않게 존재하는 것만 남긴다.
 * 파일이 없거나 형식이 틀리면 빈 배열 → 코드 읽기 기능만 꺼지고 봇은 정상 동작한다.
 */
export function loadCodeProjects(): CodeProject[] {
  const file = process.env.CODE_PROJECTS_FILE ?? path.join(ROOT_DIR, 'code-projects.json');
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const out: CodeProject[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { name, path: p, description } = item as Record<string, unknown>;
    if (typeof name !== 'string' || typeof p !== 'string') continue;
    // 존재하는 디렉토리만 화이트리스트에 넣는다.
    let exists = false;
    try {
      exists = fs.statSync(p).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) continue;
    out.push({ name, path: p, description: typeof description === 'string' ? description : '' });
  }
  return out;
}

/** claude에게 넘길 "읽을 수 있는 프로젝트" 안내 문단. 프로젝트가 없으면 빈 문자열. */
export function buildProjectsContext(projects: CodeProject[]): string {
  if (projects.length === 0) return '';
  const lines = projects.map((p) => `- ${p.name} (${p.path})${p.description ? ` — ${p.description}` : ''}`);
  return (
    '아래는 이 질문에 답할 때 참고할 사내 프로젝트 소스코드 목록이다. 질문이 특정 프로젝트의 코드·동작·설정과 ' +
    '관련되면, 관련 프로젝트의 경로에서 파일을 직접 읽어(Read/Grep/Glob) 근거를 확인한 뒤 답해라. ' +
    '질문과 무관하면 읽지 않아도 된다. 근거는 이 목록의 프로젝트 안에서 찾아라.\n' +
    '\n' +
    '중요: 각 프로젝트에는 그 프로젝트만의 Claude Code 세팅이 있다(이 세팅들은 자동 로드되지 않으니 필요하면 네가 직접 읽어라). ' +
    '어떤 프로젝트의 코드를 살펴보기 전에, 그 프로젝트 루트의 다음을 먼저 읽어 규칙·용어·구조를 파악하고 그대로 따라라:\n' +
    '- `CLAUDE.md` — 프로젝트 개요·빌드·컨벤션. 안에 `@경로` 형태의 import가 있으면 그 파일도 따라 읽어라(예: `@.claude/glossary.md`).\n' +
    '- `.claude/glossary.md` — 용어 사전(있으면).\n' +
    '- `.claude/rules/*.md` — 아키텍처·도메인별 규칙(있으면). 질문 도메인에 해당하는 파일을 읽어라.\n' +
    '- `.claude/skills/*/SKILL.md`, `.claude/agents/*.md` — 이 세션에 스킬·에이전트로 자동 등록되지는 않지만, 해당 작업에 관련되면 그 정의 파일을 문서로 읽어 절차·지식을 참고해라.\n' +
    '(`.claude/settings.json` 같은 권한·환경 설정은 이 봇 실행에 적용되지 않으니 참고 대상이 아니다.)\n' +
    lines.join('\n')
  );
}
