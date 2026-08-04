# 백엔드 함정 (Spring Boot / JPA / Flyway / 테스트)

뷰티보이에서 실제로 밟은 함정만 모았다. 각 항목은 "증상 → 원인 → 처방" 순서다.

## H2 create-drop 녹색은 실 DB 동작을 보증하지 않는다

**증상:** 유닛/슬라이스 테스트가 전부 녹색인데 실 MySQL에서 앱 기동 실패 또는 특정 API 100% 500.

**원인 두 갈래:**
1. 테스트 프로필이 H2 `ddl-auto: create-drop`이면 Hibernate가 엔티티대로 스키마를 만든다.
   Flyway DDL(TINYINT 등)과 엔티티 타입(int)이 어긋나도 테스트는 못 잡고, 실 MySQL +
   `ddl-auto: validate`에서만 `SchemaManagementException`으로 터진다.
2. H2는 `Connection.setReadOnly(true)`를 강제하지 않지만 MySQL Connector/J는 강제한다.
   `@Transactional(readOnly=true)` 안에서 쓰기(조회수 UPDATE 등)를 하면 테스트 수백 개가
   녹색인 채로 실 MySQL에서만 500이 난다.

**처방:**
- 실 DB Testcontainer에 Flyway를 걸고 `ddl-auto=validate`로 컨텍스트를 띄우는
  스모크 통합테스트를 만들고, **엔티티를 추가/변경한 태스크마다** 이 통과를 DoD로 둔다.
  주의: 이 테스트는 엔티티가 존재해야 잡는다. 스키마만 먼저 넣은 태스크에서 녹색이었다고
  엔티티 태스크에서 생략하면 최종 게이트에서 터진다 (실제로 두 번 재발했다).
- 타입 불일치는 스키마가 진실이다. 엔티티에 `@JdbcTypeCode(SqlTypes.TINYINT)` 등으로 맞춘다.
- 읽기 전용 트랜잭션 안에서 쓰기가 필요하면 `TransactionTemplate` + `REQUIRES_NEW`로 별도
  트랜잭션을 연다. `@Transactional(REQUIRES_NEW)` 애노테이션만으로는 부족하다. try/catch가
  프록시 안쪽에 있으면 예외를 삼켜도 커밋 시점에 다시 터진다.

## 스프링 테스트 컨텍스트 캐시(기본 32) 초과가 공유 H2를 DROP

**증상:** 원인 클래스가 아니라 마지막에 도는 무관한 테스트가
`Table "..." not found (this database is empty)`로 터진다.

**원인:** 컨텍스트가 32개를 넘으면 LRU로 닫히는데, `create-drop` + 공유 인메모리 H2
(`jdbc:h2:mem:공유이름`) 조합에서는 그 닫힘이 살아 있는 다른 컨텍스트의 테이블까지 지운다.

**처방:** `src/test/resources/spring.properties`에 `spring.test.context.cache.maxSize=64`.
값의 의미는 "현재 컨텍스트 수보다 넉넉히 크다"가 전부다. 증상이 재발하면 이 값부터 의심.

## Flyway 번호는 머지 직전에 확정한다

**증상:** 계획서에 번호를 고정했는데(예: T1=V78, T2=V79) 머지 시점에 로컬 기동 실패.

**원인:** 번호 고정은 병렬 터미널끼리의 충돌만 막는다. 그 사이 main에 더 높은 번호가
머지되면 역전되고, Flyway `out-of-order=false`(기본값)가 기동을 거부한다.
**통합테스트는 이 사고를 영영 못 잡는다.** Testcontainers는 매번 빈 DB에 clean 로드라
역전 상황 자체가 안 만들어진다. 전부 녹색인 채로 로컬만 죽는다.

**처방:**
- 머지 게이트에서 `ls .../db/migration/ | tail -3`으로 현재 최대 번호를 재확인하고
  낮으면 그 자리에서 rename한다.
- rename 시 문자열 리터럴을 놓치기 쉽다. 테스트 단언 속 `"78"` 같은 것은 일괄 치환이
  못 잡으므로 rename 뒤 통합테스트를 다시 돌린다.
- 계획서의 머지 게이트 체크리스트에 "번호 재확인" 항목을 넣는다.

## bootRun은 C2 JIT을 끈다 (성능 측정 왜곡)

**증상:** 서버 성능이 이유 없이 나쁘게 측정된다.

**원인:** `./gradlew bootRun`은 `optimizedLaunch=true` 기본값 때문에
`-XX:TieredStopAtLevel=1`(C2 비활성)로 뜬다. 실측에서 p95 1.86배, RPS 1.98배 차이가 났다.

**처방:** 성능 측정은 `./gradlew bootJar` 후 `java -jar`로 띄워서 한다. 측정 전
`ps -o command= -p $(lsof -nP -iTCP:<포트> -sTCP:LISTEN -t)`로 JVM 플래그를 확인하고,
리포트에 어느 구성으로 쟀는지 적는다.

## 기타 짧은 것들

- **jjwt 시크릿은 Base64.** `Decoders.BASE64.decode`로 파싱하므로 평문 시크릿은
  `DecodingException`으로 기동 실패한다. `openssl rand -base64 48`로 생성.
- **호스트 포트 충돌.** 로컬에 Homebrew MySQL 등이 3306을 점유하고 있으면 compose의
  호스트 포트를 처음부터 13306 같은 비표준으로 빼 둔다. 컨테이너끼리는 표준 포트 그대로.
- **Testcontainers 버전 핀.** Boot BOM의 Testcontainers가 최신 Docker Engine과 어긋나면
  "Could not find a valid Docker environment"로 죽는다. `extra["testcontainers.version"]`으로
  강제한다. `platform()`은 dependency-management 플러그인이 되돌리므로 통하지 않는다.
- **Kafka 리스너 두 개.** 브로커가 compose 내부용(`kafka:9092`)과 호스트용(`localhost:29092`)
  리스너를 함께 광고하는 구성이면, 호스트에서 붙을 때 내부 주소를 쓰면 조용히 안 돈다.
