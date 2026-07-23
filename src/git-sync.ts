// 등록된 프로젝트 소스를 읽기 전에 remote main 최신으로 맞춘다.
//
// 정책: 봇이 구동되는 환경의 이 사본들은 아무도 수정하지 않는 읽기 전용이며 항상 main을
// 유지한다. 그래서 강제로(reset --hard) remote main과 일치시켜도 잃을 게 없다.
//
// 단, 개발자 로컬에서는 같은 폴더가 실제 작업 브랜치(feature 등)+미커밋 변경 상태일 수 있고,
// 그 상태에서 reset --hard를 돌리면 작업이 날아간다. 그래서 기본은 꺼두고, 봇 구동 환경에서만
// CODE_SYNC=1로 켠다. 꺼져 있으면 아무것도 건드리지 않는다.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CodeProject } from './code-projects.js';

const exec = promisify(execFile);

const SYNC_ENABLED = () => process.env.CODE_SYNC === '1';
const SYNC_BRANCH = () => process.env.CODE_SYNC_BRANCH ?? 'main';
const GIT_TIMEOUT_MS = 30_000;

export interface SyncResult {
  name: string;
  status: 'updated' | 'already' | 'failed' | 'skipped';
  detail: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, timeout: GIT_TIMEOUT_MS });
  return stdout.trim();
}

/** 한 프로젝트를 remote <branch> 최신으로 강제 정렬. 실패해도 예외를 밖으로 던지지 않는다. */
async function syncOne(project: CodeProject): Promise<SyncResult> {
  const branch = SYNC_BRANCH();
  try {
    // remote 최신 정보만 먼저 가져온다(로컬 미변경).
    await git(project.path, ['fetch', 'origin', branch]);

    // 이미 로컬이 origin/branch와 같은 커밋이면 건드릴 필요 없다.
    const [local, remote] = await Promise.all([
      git(project.path, ['rev-parse', 'HEAD']).catch(() => ''),
      git(project.path, ['rev-parse', `origin/${branch}`]),
    ]);
    const onBranch = await git(project.path, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
    if (local && local === remote && onBranch === branch) {
      return { name: project.name, status: 'already', detail: `${branch} 최신 (${remote.slice(0, 7)})` };
    }

    // 강제 정렬: 대상 브랜치로 이동 후 origin 커밋으로 하드 리셋.
    await git(project.path, ['checkout', branch]);
    await git(project.path, ['reset', '--hard', `origin/${branch}`]);
    return { name: project.name, status: 'updated', detail: `${branch} → ${remote.slice(0, 7)} 로 최신화` };
  } catch (e) {
    return { name: project.name, status: 'failed', detail: e instanceof Error ? e.message.split('\n')[0] : String(e) };
  }
}

/**
 * 등록된 모든 프로젝트를 병렬로 최신화한다. CODE_SYNC!=1이면 아무것도 하지 않는다.
 * 결과는 claude 프롬프트에 넣을 한 문단으로 만들어 반환한다(빈 문자열이면 알릴 것 없음).
 */
export async function syncProjects(projects: CodeProject[]): Promise<{ results: SyncResult[]; context: string }> {
  if (!SYNC_ENABLED()) {
    return { results: [], context: '' };
  }
  const results = await Promise.all(projects.map(syncOne));

  const failed = results.filter((r) => r.status === 'failed');
  const lines = results.map((r) => `- ${r.name}: ${r.detail}`);
  let context =
    `아래 프로젝트 소스는 방금 remote ${SYNC_BRANCH()} 기준으로 최신화됐다. 이 코드를 최신으로 신뢰하고 답해라.\n` +
    lines.join('\n');
  if (failed.length > 0) {
    context +=
      `\n(주의: 위 중 최신화에 실패한 프로젝트가 있다. 그 프로젝트 코드는 최신이 아닐 수 있으니 감안해라.)`;
  }
  return { results, context };
}
