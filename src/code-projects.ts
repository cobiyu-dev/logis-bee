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
    lines.join('\n')
  );
}
