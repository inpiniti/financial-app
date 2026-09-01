import { describe, expect, it, vi } from 'vitest';
import {
  buildDaytimeQuoteTrKey,
  buildFreeQuoteTrKey,
  OverseasRealtimePriceClient,
  parseOverseasRealtimeTick,
  parseRawFrame,
  REALTIME_PRICE_TR_ID,
} from './realtimePrice';
import type { WebSocketLike } from './types';

// 실시간지연체결가.md Body 표 순서 그대로 합성한 26개 필드 (인덱스 0~25).
const DOC_ORDER_FIELDS = [
  'DNASAAPL', // 0 RSYM
  'AAPL', // 1 SYMB
  '2', // 2 ZDIV
  '20260729', // 3 TYMD
  '260729', // 4 XYMD
  '093000', // 5 XHMS
  '260730', // 6 KYMD
  '223000', // 7 KHMS
  '200.00', // 8 OPEN
  '205.00', // 9 HIGH
  '199.00', // 10 LOW
  '203.50', // 11 LAST
  '2', // 12 SIGN
  '1.50', // 13 DIFF
  '0.74', // 14 RATE
  '203.40', // 15 PBID
  '203.60', // 16 PASK
  '100', // 17 VBID
  '120', // 18 VASK
  '50', // 19 EVOL
  '1000000', // 20 TVOL
  '203500000', // 21 TAMT
  '10', // 22 BIVL
  '20', // 23 ASVL
  '55.5', // 24 STRN
  '1', // 25 MTYP
];

describe('parseOverseasRealtimeTick (④ WS 체결가 파싱)', () => {
  it('문서 순서의 합성 필드 배열을 인덱스 그대로 틱 객체 필드에 매핑한다', () => {
    const tick = parseOverseasRealtimeTick(DOC_ORDER_FIELDS);
    expect(tick).toEqual({
      RSYM: 'DNASAAPL',
      SYMB: 'AAPL',
      ZDIV: '2',
      TYMD: '20260729',
      XYMD: '260729',
      XHMS: '093000',
      KYMD: '260730',
      KHMS: '223000',
      OPEN: '200.00',
      HIGH: '205.00',
      LOW: '199.00',
      LAST: '203.50',
      SIGN: '2',
      DIFF: '1.50',
      RATE: '0.74',
      PBID: '203.40',
      PASK: '203.60',
      VBID: '100',
      VASK: '120',
      EVOL: '50',
      TVOL: '1000000',
      TAMT: '203500000',
      BIVL: '10',
      ASVL: '20',
      STRN: '55.5',
      MTYP: '1',
    });
  });

  it('필드 개수가 26개가 아니면 throw한다 (조용히 잘못된 값 계산 방지)', () => {
    expect(() => parseOverseasRealtimeTick(DOC_ORDER_FIELDS.slice(0, 10))).toThrow(/필드 개수/);
  });
});

describe('parseRawFrame', () => {
  it('파이프 envelope(<flag>|<trId>|<count>|<^필드...>)에서 TR_ID와 필드 그룹을 뽑아낸다', () => {
    const raw = `0|${REALTIME_PRICE_TR_ID}|001|${DOC_ORDER_FIELDS.join('^')}`;
    const frame = parseRawFrame(raw);
    expect(frame?.trId).toBe(REALTIME_PRICE_TR_ID);
    expect(frame?.fieldGroups).toHaveLength(1);
    expect(frame?.fieldGroups[0]).toEqual(DOC_ORDER_FIELDS);
  });

  it('필드 구분자가 없으면 null을 반환한다', () => {
    expect(parseRawFrame('{"header":{"tr_id":"PINGPONG"}}')).toBeNull();
  });
});

describe('buildFreeQuoteTrKey', () => {
  it('D+시장구분+종목코드 형태로 조립한다 (문서 예시: DNASAAPL)', () => {
    expect(buildFreeQuoteTrKey('NAS', 'AAPL')).toBe('DNASAAPL');
  });
});

describe('buildDaytimeQuoteTrKey', () => {
  it('R+시장구분+종목코드 형태로 조립한다 (문서 예시: RBAQAAPL, 나스닥-주간)', () => {
    expect(buildDaytimeQuoteTrKey('BAQ', 'AAPL')).toBe('RBAQAAPL');
  });

  it('뉴욕-주간(BAY)·아멕스-주간(BAA)도 동일 규칙으로 조립한다', () => {
    expect(buildDaytimeQuoteTrKey('BAY', 'TSLA')).toBe('RBAYTSLA');
    expect(buildDaytimeQuoteTrKey('BAA', 'F')).toBe('RBAAF');
  });
});

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }

  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.onclose?.({});
  }

  triggerOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.({});
  }

  triggerMessage(data: string): void {
    this.onmessage?.({ data });
  }

  triggerAbnormalClose(): void {
    this.readyState = 3;
    this.onclose?.({});
  }
}

describe('OverseasRealtimePriceClient', () => {
  it('staleSubscriptions — 첫 열림에 해제 프레임을 먼저 보내고(구독 복원보다 앞), 구독 집합엔 넣지 않으며 재연결엔 다시 안 보낸다(2026-08-28)', () => {
    FakeWebSocket.reset();
    const client = new OverseasRealtimePriceClient(
      {
        approvalKey: 'approval-key',
        onTick: vi.fn(),
        staleSubscriptions: [{ trKey: 'RBAQOLD', trId: REALTIME_PRICE_TR_ID }],
        reconnect: { baseDelayMs: 0, maxDelayMs: 0 },
        idleTimeoutMs: 0, // setTimeoutImpl이 즉시 실행이라 워치독이 켜져 있으면 열리자마자 발화한다.
      },
      { WebSocketImpl: FakeWebSocket, setTimeoutImpl: (fn) => fn() },
    );
    client.connect();
    client.subscribe('DNASAAPL'); // 열리기 전 구독 — 열릴 때 복원된다.
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    const frames = socket.sent.map((s) => JSON.parse(s));
    expect(frames.map((f) => [f.header.tr_type, f.body.input.tr_key])).toEqual([
      ['2', 'RBAQOLD'], // 잔재 해제 먼저
      ['1', 'DNASAAPL'], // 그다음 복원
    ]);
    expect(client.subscribedKeys.has('RBAQOLD')).toBe(false);

    socket.triggerAbnormalClose(); // 재연결(지연 0) → 새 소켓
    const socket2 = FakeWebSocket.instances[1];
    socket2.triggerOpen();
    const frames2 = socket2.sent.map((s) => JSON.parse(s));
    expect(frames2.map((f) => [f.header.tr_type, f.body.input.tr_key])).toEqual([['1', 'DNASAAPL']]);
  });

  it('setApprovalKey + reconnect — 새 소켓을 열고 복원 등록 프레임에 새 접속키를 쓴다(계좌 화면 "새로 발급" 버튼, 2026-08-28)', () => {
    FakeWebSocket.reset();
    const client = new OverseasRealtimePriceClient(
      { approvalKey: 'key-old', onTick: vi.fn() },
      { WebSocketImpl: FakeWebSocket },
    );
    client.connect();
    FakeWebSocket.instances[0].triggerOpen();
    client.subscribe('DNASAAPL');
    expect(JSON.parse(FakeWebSocket.instances[0].sent.at(-1)!).header.approval_key).toBe('key-old');

    client.setApprovalKey('key-new');
    client.reconnect();
    expect(FakeWebSocket.instances[0].closed).toBe(true);
    const socket2 = FakeWebSocket.instances[1];
    socket2.triggerOpen();
    const frame = JSON.parse(socket2.sent.at(-1)!);
    expect(frame.header.approval_key).toBe('key-new');
    expect(frame.body.input.tr_key).toBe('DNASAAPL'); // 구독 복원.
  });

  it('subscribe/unsubscribe가 등록/해제 프레임을 전송하고 구독 집합을 관리한다', () => {
    FakeWebSocket.reset();
    const onTick = vi.fn();
    const client = new OverseasRealtimePriceClient(
      { approvalKey: 'approval-key', onTick },
      { WebSocketImpl: FakeWebSocket },
    );
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    client.subscribe('DNASAAPL');
    expect(client.subscribedKeys.has('DNASAAPL')).toBe(true);
    const sentFrame = JSON.parse(socket.sent.at(-1)!);
    expect(sentFrame.header.tr_type).toBe('1');
    expect(sentFrame.body.input.tr_id).toBe(REALTIME_PRICE_TR_ID);
    expect(sentFrame.body.input.tr_key).toBe('DNASAAPL');

    client.unsubscribe('DNASAAPL');
    expect(client.subscribedKeys.has('DNASAAPL')).toBe(false);
    const unsubFrame = JSON.parse(socket.sent.at(-1)!);
    expect(unsubFrame.header.tr_type).toBe('2');
  });

  it('데이터 프레임 수신 시 onTick으로 파싱된 틱을 전달한다', () => {
    FakeWebSocket.reset();
    const onTick = vi.fn();
    const client = new OverseasRealtimePriceClient(
      { approvalKey: 'approval-key', onTick },
      { WebSocketImpl: FakeWebSocket },
    );
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    socket.triggerMessage(`0|${REALTIME_PRICE_TR_ID}|001|${DOC_ORDER_FIELDS.join('^')}`);

    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick.mock.calls[0][0].SYMB).toBe('AAPL');
    expect(onTick.mock.calls[0][1]).toBe('AAPL');
  });

  it('② 다른 TR_ID 데이터 프레임은 무시한다(체결가 HDFSCNT0만 소비)', () => {
    FakeWebSocket.reset();
    const onTick = vi.fn();
    const client = new OverseasRealtimePriceClient(
      { approvalKey: 'approval-key', onTick },
      { WebSocketImpl: FakeWebSocket },
    );
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    socket.triggerMessage(`0|${REALTIME_PRICE_TR_ID}|001|${DOC_ORDER_FIELDS.join('^')}`);
    socket.triggerMessage(`0|HDFSASP0|001|AAPL^2^20260729^093000`);

    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick.mock.calls[0][0].SYMB).toBe('AAPL');
  });

  it('RAW_FIELD_DEBUG(rawFieldDebug) 모드에서는 onRawFields로 원본 필드 배열도 노출한다', () => {
    FakeWebSocket.reset();
    const onTick = vi.fn();
    const onRawFields = vi.fn();
    const client = new OverseasRealtimePriceClient(
      { approvalKey: 'approval-key', rawFieldDebug: true, onTick, onRawFields },
      { WebSocketImpl: FakeWebSocket },
    );
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    socket.triggerMessage(`0|${REALTIME_PRICE_TR_ID}|001|${DOC_ORDER_FIELDS.join('^')}`);

    expect(onRawFields).toHaveBeenCalledWith(DOC_ORDER_FIELDS, 'AAPL');
  });

  it('PINGPONG 메시지는 그대로 되돌려 세션을 유지한다', () => {
    FakeWebSocket.reset();
    const onTick = vi.fn();
    const client = new OverseasRealtimePriceClient(
      { approvalKey: 'approval-key', onTick },
      { WebSocketImpl: FakeWebSocket },
    );
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    const pingpong = '{"header":{"tr_id":"PINGPONG","datetime":"20260729093000"}}';
    socket.triggerMessage(pingpong);

    expect(socket.sent.at(-1)).toBe(pingpong);
    expect(onTick).not.toHaveBeenCalled();
  });

  it('⑤ 비정상 종료 시 지수 백오프로 재연결하고 기존 구독을 복원한다', () => {
    FakeWebSocket.reset();
    const onTick = vi.fn();
    const onStatusChange = vi.fn();
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const client = new OverseasRealtimePriceClient(
      // idleTimeoutMs 0 — 이 테스트는 재연결 예약 개수를 세므로 무음 워치독 타이머를 끈다(워치독은 전용 테스트).
      { approvalKey: 'approval-key', onTick, onStatusChange, reconnect: { baseDelayMs: 100, maxDelayMs: 1000 }, idleTimeoutMs: 0 },
      {
        WebSocketImpl: FakeWebSocket,
        setTimeoutImpl: (fn, ms) => {
          scheduled.push({ fn, ms });
          return scheduled.length;
        },
        clearTimeoutImpl: () => {},
      },
    );

    client.connect();
    const socket1 = FakeWebSocket.instances[0];
    socket1.triggerOpen();
    client.subscribe('DNASAAPL');

    // 1차 비정상 종료 → 100ms 후 재시도 예약
    socket1.triggerAbnormalClose();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].ms).toBe(100);

    scheduled[0].fn(); // 재연결 실행
    const socket2 = FakeWebSocket.instances[1];
    expect(socket2).toBeDefined();
    socket2.triggerAbnormalClose(); // 2차 실패 → 지수 증가(200ms)
    expect(scheduled).toHaveLength(2);
    expect(scheduled[1].ms).toBe(200);

    scheduled[1].fn();
    const socket3 = FakeWebSocket.instances[2];
    socket3.triggerOpen();
    // 재연결 성공 시 기존 구독(DNASAAPL)을 다시 등록 프레임으로 보낸다.
    const resubFrame = JSON.parse(socket3.sent.at(-1)!);
    expect(resubFrame.body.input.tr_key).toBe('DNASAAPL');
    expect(resubFrame.header.tr_type).toBe('1');

    expect(onStatusChange).toHaveBeenCalledWith('reconnecting');
  });

  it('구독 성공 ACK(JSON 제어 프레임)을 onControl로 전달한다', () => {
    FakeWebSocket.reset();
    const onTick = vi.fn();
    const onControl = vi.fn();
    const client = new OverseasRealtimePriceClient(
      { approvalKey: 'approval-key', onTick, onControl },
      { WebSocketImpl: FakeWebSocket },
    );
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    const ack = JSON.stringify({
      header: { tr_id: REALTIME_PRICE_TR_ID, tr_key: 'DNASAAPL', encrypt: 'N' },
      body: { rt_cd: '0', msg_cd: 'OPSP0000', msg1: 'SUBSCRIBE SUCCESS' },
    });
    socket.triggerMessage(ack);

    expect(onControl).toHaveBeenCalledWith({
      trId: REALTIME_PRICE_TR_ID,
      trKey: 'DNASAAPL',
      rtCd: '0',
      msgCd: 'OPSP0000',
      msg1: 'SUBSCRIBE SUCCESS',
    });
    expect(onTick).not.toHaveBeenCalled();
  });

  it('구독 실패 ACK(JSON 제어 프레임)도 onControl로 전달한다(판단은 상위에서)', () => {
    FakeWebSocket.reset();
    const onTick = vi.fn();
    const onControl = vi.fn();
    const client = new OverseasRealtimePriceClient(
      { approvalKey: 'approval-key', onTick, onControl },
      { WebSocketImpl: FakeWebSocket },
    );
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    const nack = JSON.stringify({
      header: { tr_id: REALTIME_PRICE_TR_ID, tr_key: 'DNASAAPL', encrypt: 'N' },
      body: { rt_cd: '1', msg_cd: 'OPSP0001', msg1: 'SUBSCRIBE ERROR' },
    });
    socket.triggerMessage(nack);

    expect(onControl).toHaveBeenCalledWith({
      trId: REALTIME_PRICE_TR_ID,
      trKey: 'DNASAAPL',
      rtCd: '1',
      msgCd: 'OPSP0001',
      msg1: 'SUBSCRIBE ERROR',
    });
  });

  it('close()로 명시적으로 닫으면 이후 재연결을 예약하지 않는다', () => {
    FakeWebSocket.reset();
    const onTick = vi.fn();
    const scheduled: Array<() => void> = [];
    const client = new OverseasRealtimePriceClient(
      { approvalKey: 'approval-key', onTick, idleTimeoutMs: 0 },
      { WebSocketImpl: FakeWebSocket, setTimeoutImpl: (fn) => (scheduled.push(fn), scheduled.length) },
    );
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.triggerOpen();

    client.close();

    expect(scheduled).toHaveLength(0);
  });

  it('무음 워치독(2026-09-01) — idleTimeoutMs 동안 아무 프레임이 없으면 소켓을 버리고 재연결을 예약한다(half-open)', () => {
    FakeWebSocket.reset();
    const onError = vi.fn();
    const scheduled: Array<{ fn: () => void; ms: number }> = [];
    const client = new OverseasRealtimePriceClient(
      { approvalKey: 'approval-key', onTick: vi.fn(), onError, idleTimeoutMs: 90_000, reconnect: { baseDelayMs: 100 } },
      {
        WebSocketImpl: FakeWebSocket,
        setTimeoutImpl: (fn, ms) => {
          scheduled.push({ fn, ms });
          return scheduled.length;
        },
        clearTimeoutImpl: () => {},
      },
    );
    client.connect();
    const socket1 = FakeWebSocket.instances[0];
    socket1.triggerOpen();
    client.subscribe('DNASAAPL');
    // 열림 시점에 워치독 1개 예약(90초). 메시지가 오면 리셋(새 타이머 예약)된다.
    expect(scheduled.filter((s) => s.ms === 90_000)).toHaveLength(1);
    socket1.triggerMessage('{"header":{"tr_id":"PINGPONG"}}');
    expect(scheduled.filter((s) => s.ms === 90_000)).toHaveLength(2);

    // 마지막 워치독이 만료 — half-open 소켓을 닫고 재연결을 예약한다.
    scheduled.at(-1)!.fn();
    expect(onError).toHaveBeenCalled();
    expect(socket1.closed).toBe(true);
    const reconnects = scheduled.filter((s) => s.ms === 100);
    expect(reconnects).toHaveLength(1);
    reconnects[0].fn();
    const socket2 = FakeWebSocket.instances[1];
    socket2.triggerOpen();
    // 구독 집합은 유지 — 새 소켓에 복원 프레임이 나간다.
    const frame = JSON.parse(socket2.sent.at(-1)!);
    expect(frame.body.input.tr_key).toBe('DNASAAPL');
    expect(frame.header.tr_type).toBe('1');
  });
});

describe('OverseasRealtimePriceClient — 단일 세션 보장 (ALREADY IN USE appkey 재발 방지)', () => {
  it('이미 연결 중/열림이면 connect()를 다시 불러도 새 소켓을 만들지 않는다', () => {
    FakeWebSocket.reset();
    const client = new OverseasRealtimePriceClient(
      { approvalKey: 'approval-key', onTick: vi.fn() },
      { WebSocketImpl: FakeWebSocket },
    );

    client.connect(); // CONNECTING 상태에서 재호출
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0].triggerOpen(); // OPEN 상태에서 재호출
    client.connect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('교체된 낡은 소켓의 늦은 onclose는 현재 소켓을 끊거나 재연결을 예약하지 않는다', () => {
    FakeWebSocket.reset();
    const scheduled: Array<() => void> = [];
    const statuses: string[] = [];
    const client = new OverseasRealtimePriceClient(
      { approvalKey: 'approval-key', onTick: vi.fn(), onStatusChange: (s) => statuses.push(s), idleTimeoutMs: 0 },
      {
        WebSocketImpl: FakeWebSocket,
        setTimeoutImpl: (fn) => {
          scheduled.push(fn);
          return scheduled.length;
        },
        clearTimeoutImpl: () => {},
      },
    );

    client.connect();
    const socket1 = FakeWebSocket.instances[0];
    socket1.triggerOpen();

    // 비정상 종료 → 백오프 재연결로 socket2 생성
    socket1.triggerAbnormalClose();
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    const socket2 = FakeWebSocket.instances[1];
    socket2.triggerOpen();
    const scheduledBefore = scheduled.length;
    const statusesBefore = [...statuses];

    // 낡은 socket1의 늦은 onclose 이벤트가 또 도착해도 무시된다
    socket1.onclose?.({});
    expect(scheduled.length).toBe(scheduledBefore); // 추가 재연결 예약 없음
    expect(statuses).toEqual(statusesBefore); // 'closed' 상태 발행 없음
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});
