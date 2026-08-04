# 접근토큰발급(P)[인증-001]

> 원문: tokenP.txt (KIS API 포탈 복사본) — 변환 시 필드 추가/삭제 없음

## 기본 정보

| 항목 | 내용 | 항목 | 내용 |
|---|---|---|---|
| Method | POST | URL | /oauth2/tokenP |
| 실전 Domain | https://openapi.koreainvestment.com:9443 | 모의 Domain | https://openapivts.koreainvestment.com:29443 |
| 실전 TR ID | (명시 없음) | 모의 TR ID | (명시 없음) |
| Format | JSON | Content-Type | application/json; charset=UTF-8 |

## 개요

본인 계좌에 필요한 인증 절차로, 인증을 통해 접근 토큰을 부여받아 오픈API 활용이 가능합니다.

1. 접근토큰(access_token)의 유효기간은 24시간 이며(1일 1회발급 원칙)
   갱신발급주기는 6시간 입니다.(6시간 이내는 기존 발급키로 응답)

2. 접근토큰발급(/oauth2/tokenP) 시 접근토큰값(access_token)과 함께 수신되는
   접근토큰 유효기간(acess_token_token_expired)을 이용해 접근토큰을 관리하실 수 있습니다.

[참고]

'23.4.28 이후 지나치게 잦은 토큰 발급 요청건을 제어 하기 위해 신규 접근토큰발급 이후 일정시간 이내에 재호출 시에는 직전 토큰값을 리턴하게 되었습니다. 일정시간 이후 접근토큰발급 API 호출 시에는 신규 토큰값을 리턴합니다.
접근토큰발급 API 호출 및 코드 작성하실 때 해당 사항을 참고하시길 바랍니다.

※ 참고 : 포럼 > 공지사항 >  [수정] [중요] 접근 토큰 발급 변경 안내

## 요청

### Header

(정의된 Header 필드 없음)

### Body

| Element | 한글명 | Type | Required | Length | Description |
|---|---|---|---|---|---|
| grant_type | 권한부여 Type | String | Y | 18 | client_credentials |
| appkey | 앱키 | String | Y | 36 | 한국투자증권 홈페이지에서 발급받은 appkey (절대 노출되지 않도록 주의해주세요.) |
| appsecret | 앱시크릿키 | String | Y | 180 | 한국투자증권 홈페이지에서 발급받은 appsecret (절대 노출되지 않도록 주의해주세요.) |

## 응답

### Header

(정의된 Header 필드 없음)

### Body

| Element | 한글명 | Type | Required | Length | Description |
|---|---|---|---|---|---|
| access_token | 접근토큰 | String | Y | 350 | OAuth 토큰이 필요한 API 경우 발급한 Access token<br>ex) "eyJ0eXUxMiJ9.eyJz….....................................”<br><br>- 일반개인고객/일반법인고객<br>. Access token 유효기간 1일<br>.. 일정시간(6시간) 이내에 재호출 시에는 직전 토큰값을 리턴<br>. OAuth 2.0의 Client Credentials Grant 절차를 준용<br><br>- 제휴법인<br>. Access token 유효기간 3개월<br>. Refresh token 유효기간 1년<br>. OAuth 2.0의 Authorization Code Grant 절차를 준용 |
| token_type | 접근토큰유형 | String | Y | 20 | 접근토큰유형 : "Bearer"<br>※ API 호출 시, 접근토큰유형 "Bearer" 입력. ex) "Bearer eyJ...." |
| expires_in | 접근토큰 유효기간 | Number | Y | 10 | 유효기간(초)<br>ex) 7776000 |
| access_token_token_expired | 접근토큰 유효기간(일시표시) | String | Y | 50 | 유효기간(년:월:일 시:분:초)<br>ex) "2022-08-30 08:10:10" |

## 예시

### Request

Data Class (Python)

```python
from dataclasses import dataclass

@dataclass
class RequestHeader:

@dataclass
class RequestBody:
    grant_type: str    #권한부여 Type
    appkey: str    #앱키
    appsecret: str    #앱시크릿키
```

### Response

Data Class (Python)

```python
from dataclasses import dataclass
from typing import List, Optional
from decimal import Decimal

@dataclass
class ResponseHeader:

@dataclass
class ResponseBody:
    access_token: str    #접근토큰
    token_type: str    #접근토큰유형
    expires_in: float    #접근토큰 유효기간
    access_token_token_expired: str    #접근토큰 유효기간(일시표시)
```
