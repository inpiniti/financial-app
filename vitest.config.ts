import { defineConfig } from 'vitest/config';

// core/ 는 RN을 모르는 순수 TS 로직, kis/ 는 fetch·WebSocket·저장소·시계를 주입받는 REST/WS 클라이언트 —
// 둘 다 RN 없이 vitest로 테스트 가능하도록 설계되어 있다.
export default defineConfig({
  test: {
    include: [
      'core/**/*.test.ts',
      'kis/**/*.test.ts',
      'lib/**/*.test.ts',
      'features/**/*.test.ts',
      '__tests__/**/*.test.ts',
    ],
    environment: 'node',
  },
});
