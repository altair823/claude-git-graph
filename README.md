# git-graph

Claude Code 오른쪽 패널에 현재 작업 디렉터리 저장소의 git 커밋 그래프를 보여 주는 mod다.
GitKraken처럼 브랜치 lane과 merge를 색으로 구분해 보여 준다.

## 보여 주는 것

- 첫 줄: 현재 브랜치, upstream과의 ahead/behind, 커밋하지 않은 변경 파일 개수
- 그 아래: `git log --graph`가 그린 그래프(로컬 브랜치, 원격 브랜치, 태그, HEAD에서 최근 300개 커밋)

그래프 모양과 선 색은 git이 직접 그린 것을 그대로 쓴다. stash는 그래프에 넣지 않는다.

## 동작

- 세션을 시작할 때 git 저장소 안이면 패널을 연다. 터미널이 144칸보다 좁으면 열리지 않고 기다린다.
- `/git-graph`는 터미널 너비와 관계없이 패널을 연다.
- 패널이 열려 있는 동안 5초마다 다시 읽고, Claude가 Bash 도구를 실행한 직후에도 다시 읽는다.
- `git status`는 `--no-optional-locks`로 실행해 다른 git 작업과 `index.lock`을 두고 충돌하지 않는다.
- 패널에 포커스를 주면 방향키로 스크롤한다.

## 설치

`altair-skills` 마켓플레이스에 들어 있다.

```
claude plugin install git-graph@altair-skills
```

## 개발

```
claude plugin validate .
claude plugin test .
```
