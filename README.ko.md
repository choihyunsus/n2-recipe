# N2R · n2-recipe

AI 작업의 필수 전후 검증과 중단 후 복구를 담당하는 실행 모듈입니다.

[English documentation](README.md)

N2R은 `.n2r` 레시피를 배포판 Clotho로 해석하고, 등록된 도구를 정해진 순서대로 실행합니다. 기본 흐름은 **부팅 → 작업 전 확인 → 실제 작업 → 작업 후 검증 → 종료 체크포인트**입니다. 작업 중에는 호스트에 등록된 도구를 자유롭게 호출합니다.

구미호 같은 에이전트 조정기는 하나의 논리적 작업을 N2R 실행 하나로 감쌀 수 있습니다. 그 안에는 여러 모델 응답과 도구 호출을 담을 수 있습니다. 완료 결과, 실행 근거와 경험은 공통 Soul DB에 소유 범위를 구분하여 저장합니다.

## 설치

Node.js 22 이상이 필요합니다. SQLite는 `better-sqlite3`를 사용하며, 호환되는 Mimir Rust 바인딩도 지원합니다. 플랫폼용 사전 빌드 바인딩을 사용할 수 없는 환경에서는 네이티브 빌드 도구가 필요할 수 있습니다.

```sh
npm install https://github.com/choihyunsus/n2-recipe/releases/download/v1.0.0/n2-recipe-1.0.0.tgz
```

이 버전은 GitHub Releases로 배포합니다. Clotho, Mimir, Personas 의존성은 공개된 GitHub 배포 파일에 고정되어 있습니다.

## 기본 역할

| 단계 | 기본 동작 |
| --- | --- |
| `boot` | 같은 프로젝트·에이전트의 과거 성공 경험 최대 4개 회상 |
| `work_start` | 호스트의 사전 확인 후 작업에 맞는 일반 전문가 지침 선택 |
| 실제 작업 | 등록된 도구 호출과 변경 파일 수집 |
| `work_end` | 작업 내용과 변경 파일 배열을 호스트 검증 함수에 전달 |
| `end` | 해당 작업의 체크포인트 저장 |

`prepare`와 `verify`에는 실제 확인 함수를 등록해야 합니다. 작업 전 검증이 실패하면 실제 작업을 시작하지 않습니다. 작업 결과가 명시적 실패인 경우에도 사후 검증을 실행합니다. 알려진 실패는 종료 단계까지 기록합니다. 실행이 중단되면 미완료 호출을 보존하고 원래 단계 순서로 복원합니다.

최종 성공은 네 단계와 작업 콜백이 모두 통과했을 때 기록합니다. 테스트 명령, 변경 파일 탐지, 결과 파일 해시, 파일·네트워크·프로세스 권한은 호스트가 구현합니다. 구체적인 모델 호출과 코드 수정도 호스트 도구가 담당합니다.

## 라이브러리 연결

```js
import { RecipeRunner } from 'n2-recipe';

const runner = new RecipeRunner({
  dbPath: './data/soul.db',
  project: 'example-project',
  agent: 'worker',
  tools: [
    {
      name: 'prepare',
      version: '1',
      readOnly: true,
      execute: (args, context) => host.prepare(args.task, context.signal),
    },
    {
      name: 'edit',
      version: '1',
      execute: (args, context) => host.edit(args, context),
    },
    {
      name: 'verify',
      version: '1',
      readOnly: true,
      execute: (args, context) => host.verify(args.files, context.signal),
    },
  ],
});

try {
  const result = await runner.run(
    { runId: 'request-001', sessionId: 'session-001', task: '요청한 기능 구현' },
    {
      version: '1',
      execute: async context => {
        await context.callTool('edit', { task: context.context.prompt });
        return { success: true, output: '작업 콜백 완료' };
      },
    },
  );
  console.log(result.success, result.experienceId);
} finally {
  await runner.close();
}
```

예시의 `host`는 연결할 애플리케이션이 제공하는 구현입니다. 도구 결과에는 `success` 불리언과 `output` 문자열이 필요하며, 선택적으로 JSON `data`와 `modifiedFiles` 배열을 반환합니다. 처리 결과를 확인한 실패는 `success: false`로 반환합니다. 예외와 시간 초과는 외부 부작용의 성공 여부가 불명확할 수 있으므로 미완료 호출로 남깁니다.

각 도구는 `AbortSignal`, 고정된 `runId`와 `callId`를 받습니다. 작업 콜백의 `context`에는 현재 작업과 추가 지침이 담깁니다. 완료 결과를 일찍 반환하더라도 이미 요청한 작업 도구들이 정리된 뒤 사후 검증으로 진행합니다.

## 중단·재시도·동시 실행

- 같은 실행 ID에 동일한 입력과 도구·작업 콜백 버전을 다시 전달하면 저장된 완료 결과를 반환합니다.
- 실행을 시작할 때 레시피를 고정합니다. 수정된 레시피는 새 실행에 적용됩니다.
- `idempotent: true`인 콜백은 미완료 호출을 재실행할 수 있습니다. 읽기 전용 도구는 기본적으로 멱등성을 인정하며, 작업 콜백은 명시적 설정이 필요합니다.
- 멱등 작업을 재실행할 때 완료된 하위 도구 결과를 재사용합니다. 인자가 달라지거나 이전 호출을 누락하면 중단합니다.
- 외부 결과를 직접 확인한 뒤 `reconcileCall(runId, callId, result, evidenceNote)`로 미완료 결과를 확정할 수 있습니다. 미완료 하위 호출을 먼저 처리한 뒤 작업 콜백 전체를 확정합니다. 이후 사후 검증도 실행합니다.
- 같은 프로젝트·에이전트에서는 실행 임대 하나만 활성화합니다. 종료된 프로세스나 만료된 임대는 교체할 수 있으며, 이전 소유자의 늦은 DB 저장은 차단합니다.

```js
const pending = runner.status('request-001');
// 외부 작업 결과를 확인한 후 그 근거와 결과를 전달합니다.
runner.reconcileCall('request-001', 'work:0', inspectedResult, evidenceNote);
const resumed = await runner.run(originalRequest, originalVersionedHandler);
```

최종 실행 결과와 Mimir 경험은 같은 트랜잭션으로 저장합니다. 마지막 저장이 실패하면 완료된 단계 기록부터 재시도할 수 있습니다. 중단된 작업은 실행 장부에 남습니다. 취소 신호를 무시하는 외부 작업은 계속 실행될 수 있으므로 강제 종료가 필요한 처리는 호스트의 별도 프로세스에 격리해야 합니다.

## 전문가 역할 선택

기본 선택기는 배포판 Personas의 일반 전문가 지침 72개를 대상으로 메타데이터 BM25와 정확한 토큰 일치를 계산합니다. 관련 역할이 있으면 작업 맥락에 지침을 추가합니다. 빈 작업이나 일치하는 내용이 없는 작업은 역할을 선택하지 않습니다.

지침은 최대 8 KiB이며 약 1,200토큰을 기준으로 한 길이 추정 한도를 적용합니다. `expertise: false`로 끄거나 `expertise: { personaId: 'dev/web-frontend' }`로 고정할 수 있습니다. 사용자 선택기는 `{ version, select(task, profiles, signal) }` 형식이며, 등록된 역할 ID 또는 `null`을 반환합니다. 선택기 버전도 재실행 식별에 포함됩니다.

독립 배포판은 작은 공개 카탈로그를 직접 검색합니다. 대붕이 통합판은 Hecaton의 분류·DNA 필터링 경로를 함께 사용합니다. 호스트의 사용자 선택기를 통해 해당 라우팅 정책을 연결할 수 있습니다.

## 레시피 구성과 수정

레시피 폴더에는 `boot.n2r`, `work_start.n2r`, `work_end.n2r`, `end.n2r`를 둡니다. 네 단계 모두 `enforce: strict`와 조건 없는 필수 검사 하나 이상이 필요합니다. 별도의 `parseRecipe` API는 구문 분석·검토에 사용할 수 있습니다.

단계 필드는 `tool` 또는 기존 `action`, `args` 또는 `args_json`, `required`, `inject`, `condition`, `on_fail`, 기존 `unlock` 메타데이터를 지원합니다. `inject`는 `system_prompt`, `user_message`, `none` 또는 맥락 변수 이름을 받습니다. 조건은 `if ${variable}` 형식이며 `has_code_changes`, `last_step_failed`를 포함합니다. 실패 처리는 `abort`, `skip`, `goto step_name`으로 지정합니다.

필수 검사 실패는 복구용 진단이 성공해도 실패로 유지합니다. 이동 명령으로 필수 단계를 건너뛰면 통과하지 못합니다. 조건부 필수 단계는 해당 조건을 실제로 평가한 뒤 적용 대상 여부를 판단합니다. 이동 반복에는 한도가 있습니다.

`${prompt}`, `${last_failure}`, `${modified_files}`, `${modified_code_files}`는 기존 문자열 치환을 지원합니다. `${modified_files_array}`, `${modified_code_files_array}`를 문자열 값 전체로 사용하면 배열로 전달하므로 쉼표가 있는 파일명도 보존합니다. 치환된 내용을 다시 해석하지 않습니다. 기존 `unlock` 값은 레시피 메타데이터로 보존하고 도구 사용 가능 여부는 호스트 등록에 따릅니다.

`runner.updateRecipe(phase, source, expectedHash)`로 작업 전후 레시피를 수정합니다. 초기 설정의 필수 절차는 정의와 상대적 순서를 유지해야 합니다. 현재 해시는 `runner.recipes()`에서 확인합니다. 부팅·종료는 초기 묶음으로 설정하며, 다른 기준 묶음을 사용할 때는 별도의 에이전트 범위를 지정합니다.

## 명령행 실행

```sh
n2-recipe validate
n2-recipe validate --recipes ./recipes
n2-recipe status --db ./data/soul.db --project demo --agent worker --run-id demo-001
n2-recipe run --adapter ./adapter.cjs --db ./data/soul.db --project demo --agent worker --run-id demo-001 --task "요청한 출력 작성"
```

운영자가 선택한 로컬 CJS·ESM 어댑터는 `tools`, `work`와 선택적인 `recipes`, `expertise`, `deadlines`를 내보냅니다. 어댑터를 불러오면 호스트 프로세스 권한으로 해당 JavaScript가 실행됩니다. 상태 조회 명령은 기존 DB를 읽기 전용으로 엽니다. 종료 코드는 성공 0, 실행·설정 오류 1, 검증 실패로 완료된 작업 2입니다.

포함된 `examples/file-task.cjs`는 실제 파일 쓰기와 내용·해시 검증을 수행합니다. `N2R_DEMO_DIR` 환경변수에 기존 임시 작업 폴더를 지정하면 그곳에 `answer.txt`를 작성합니다. 새로운 논리적 작업에는 새 실행 ID를 사용합니다.

## Soul 공통 DB

배포판 Soul·Mimir가 사용하는 로컬 SQLite 파일을 `dbPath`로 지정합니다. `project`와 `agent`가 소유 범위이며, 실행과 경험에는 `session_id`도 기록합니다. 공통 기억 테이블은 Mimir 3.0.3의 스키마를 사용합니다.

추가 테이블은 `n2r_configuration`, `n2r_runs`, `n2r_calls`, `n2r_leases`, `n2r_checkpoints`입니다. `meta.n2r_schema_version = 1`로 버전을 기록합니다. 기존의 버전 없는 N2R 테이블은 명시적 이전 절차가 필요합니다. 레시피 해시, 호출 인자, 결과와 복구 근거가 저장되므로 인증 정보는 어댑터 클로저와 환경변수에 보관하고 호출 기록에는 작업 데이터를 담습니다.

## 실행 한도

| 항목 | 한도·기본값 |
| --- | --- |
| 레시피 소스·단계 수 | 단계별 64 KiB·64개 |
| 단계 반복 | 정의된 단계 수의 3배 |
| JSON 깊이·입력 요소 | 16단계·4,096개 |
| 도구 인자·출력 문자열·데이터 | 64 KiB·64 KiB·16 KiB |
| 결과·전체 맥락·추가 지침 하나 | 128 KiB·256 KiB·8 KiB |
| 실행당 호출·호출 기록 | 2,048개·8 MiB, 미완료 결과 예약 공간 포함 |
| 대기 중인 작업 인자 | 512 KiB, 순서대로 실행 |
| 도구·단계·작업 시간 | 30초·120초·300초 |
| 시간 설정 범위 | 1밀리초부터 1시간 |
| 실행 임대·갱신 | 30초·10초 |

비동기 콜백에는 시간 제한과 취소 신호를 적용합니다. 동기 CPU 작업의 강제 시간 제한은 호스트 프로세스 격리가 필요합니다. 자원 한도에 도달하면 이미 기록된 작업 효과를 보존합니다. 중단 기록을 확인한 뒤 복구 방법을 결정합니다.

## 개발과 라이선스

```sh
npm ci
npm test
npm run typecheck
```

검증에는 실제 파일 변경, 검증 실패, 레시피 갱신, 프로세스 강제 종료, 불확실한 외부 결과, 재실행 분기 불일치, 임대 교체, 트랜잭션 롤백, 전문가 선택과 명령행 실행이 포함됩니다. 배포 파일은 새로운 소비자 환경에서도 검증합니다.

N2R 구현은 MIT 라이선스입니다. Clotho와 Mimir는 별도의 비상업·상업 이용 조건을 유지합니다. 재배포와 상업적 사용 시 포함된 의존성 라이선스 및 `THIRD-PARTY-NOTICES`를 확인해 주세요.
