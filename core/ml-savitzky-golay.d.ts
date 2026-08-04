// ml-savitzky-golay(2.0.4)는 타입 선언을 배포하지 않아 앰비언트로 최소 시그니처만 선언한다.
// core/ 가 import 허용된 유일한 외부 라이브러리(작업 스펙).
declare module 'ml-savitzky-golay' {
  interface SavitzkyGolayOptions {
    /** 필터링에 쓰는 점 개수(홀수, 5 이상). 기본 5 */
    windowSize?: number;
    /** 미분 차수. 0=평활, 1=기울기, 2=가속도. 기본 1 */
    derivative?: number;
    /** 다항식 차수. 기본 2 */
    polynomial?: number;
    /** 경계 패딩 방식. 기본 'none' */
    pad?: 'none' | 'pre' | 'post';
    /** 패딩 값/전략. 기본 'replicate' */
    padValue?: number | 'circular' | 'replicate' | 'symmetric';
  }
  function SavitzkyGolay(
    data: number[],
    h: number,
    options?: SavitzkyGolayOptions,
  ): number[];
  export = SavitzkyGolay;
}
