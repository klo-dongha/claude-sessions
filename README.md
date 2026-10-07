# claude-sessions

A read-only local dashboard for every **Claude Code** session running on your Mac.
Click a session card and the Terminal tab it lives in comes to the front.

- Live list of all sessions across projects: status (working / waiting for input / idle), last request, last reply, running tool, remaining context
- **Model and effort** per session
- **Plan limits** (5-hour window, weekly all-models, weekly per-model) with reset times, same source as `/usage`
- **Token usage** aggregated from local transcripts: today, last 7 days, daily, hourly (24h), per model, per session
- Zero dependencies. One `server.js`, one `index.html`.

> 한국어 설명은 아래에 있습니다.

## Requirements

- macOS with **Terminal.app** (iTerm2 and others are not supported yet; see below)
- Node.js 18+
- Claude Code CLI 2.1.139+ (`claude agents --json` must work)

## Run

```bash
npx github:klo-dongha/claude-sessions
```

or

```bash
git clone https://github.com/klo-dongha/claude-sessions
cd claude-sessions
npm start
```

The browser opens at `http://localhost:4747`. Options: `--port=5000`, `--no-open`.

The first time, macOS may ask to allow Terminal (or Node) to control **Terminal.app** (for tab focus) and to read the
**Claude Code-credentials** keychain item (for plan limits). Both are optional: deny them and the dashboard still works,
only tab focusing or the plan-limit panel is unavailable.

## How it works

| What | Source |
|---|---|
| Session list and status | `claude agents --json`, polled every 2s |
| Last request / reply / tool / context left / model / effort | tail of `~/.claude/projects/<project>/<session-id>.jsonl`, read incrementally |
| Terminal tab title and focus | `ps` gives the session's TTY; AppleScript matches it to a Terminal.app tab |
| Plan limits | `GET https://api.anthropic.com/api/oauth/usage` with the OAuth token from the macOS keychain item `Claude Code-credentials`, refreshed every 60s. The token is sent only to `api.anthropic.com`. This endpoint is undocumented and may change; if it fails, only that panel shows an error. |
| Token usage | all transcripts modified in the last 7 days, `assistant` entries deduplicated by `message.id`, rescanned incrementally every 10s |

Sessions not attached to a terminal (`claude --bg`) are opened in a new Terminal window with `claude attach <name>`.

Status colors: yellow = Claude is working, red = Claude finished and is waiting for your input, green = idle.

## Limitations

- Terminal.app only. To support iTerm2, replace the two AppleScript snippets in `server.js` (`TABS_SCRIPT`, `focusScript`).
- Read-only: it does not send messages to sessions. Click through to the terminal for that.
- "Output tokens" is the headline number; the input figure includes cache reads and is mostly cache.

## License

MIT

---

## 한국어

이 Mac에서 돌아가는 모든 Claude Code 세션을 브라우저에서 한눈에 보는 읽기 전용 대시보드입니다.
카드를 클릭하면 그 세션이 떠 있는 Terminal.app 탭이 앞으로 올라옵니다.

### 실행

```bash
npx github:klo-dongha/claude-sessions
```

또는 저장소를 받아서 `npm start`. 브라우저가 `http://localhost:4747`로 열립니다. 옵션: `--port=5000`, `--no-open`.

처음 실행하면 macOS가 Terminal.app 제어 권한(탭 포커스용)과 키체인 `Claude Code-credentials` 읽기(플랜 한도용)를
물어볼 수 있습니다. 둘 다 거부해도 대시보드는 동작하고, 해당 기능만 빠집니다.

### 표시 내용

- 세션 상태: 작업 중(노랑), 입력 대기(빨강), 유휴(초록). 마지막 요청과 답변, 실행 중인 도구, 남은 컨텍스트
- 세션별 model / effort, 7일 사용량
- 플랜 한도: 5시간 세션 창, 주간 전체, 주간 모델별 한도와 리셋 시각. Claude Code의 `/usage`와 같은 출처
- 토큰 사용량: 오늘, 최근 7일, 일별, 최근 24시간 시간별, 모델별

### 제약

- Terminal.app 전용입니다. iTerm2는 `server.js`의 AppleScript 두 곳을 바꾸면 됩니다.
- 읽기 전용입니다. 세션에 메시지를 보내는 기능은 없습니다.
