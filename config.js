/* ============================================================
 * 동기화 서버 설정 — 서버를 옮길 때는 이 파일만 바꾸면 됩니다.
 *
 * url : Supabase 대시보드 → Project Settings → API(또는 Data API) 의 Project URL
 * key : 같은 화면의 공개 키 (anon public 또는 sb_publishable_... 로 시작하는 키)
 *       ※ service_role / secret 키는 절대 넣지 마세요 (브라우저에 노출됨)
 *
 * url 을 비워 두면 동기화 없이 지금처럼 이 기기에만 저장합니다.
 *
 * 다른 서버로 옮길 때
 *   - 자체 호스팅 Supabase    : url, key 만 교체
 *   - PostgreSQL + PostgREST   : adapter 'postgrest', restPath/authPath 를 그 서버 경로로
 *   - 그 외(PocketBase 등)      : sync.js 에 같은 5개 함수를 가진 어댑터를 추가하고 adapter 이름 지정
 * ============================================================ */
window.LEDGER_SYNC_CONFIG = {
  adapter: 'postgrest',
  url: 'https://prbyeqocblevmtjwnsvo.supabase.co',          // 예: 'https://abcdefghijk.supabase.co'
  key: 'sb_publishable_GVu_yIMsOLfcdgl4Nfmc5A_mbxy0ZAh',          // 예: 'sb_publishable_xxx' 또는 'eyJhbGciOi...'(anon)
  restPath: '/rest/v1',
  authPath: '/auth/v1'
};
