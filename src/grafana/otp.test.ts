// parseOtp 단위 테스트 — 브라우저·서버 의존 없음.
// 실행: node --import tsx --test src/grafana/otp.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOtp } from './otp.js';

// Authenticator 확장 팝업의 innerText는 대략 "계정 라벨 줄 → 코드 줄" 순으로 쌓인다.
test('계정 라벨 줄 아래의 6자리 코드를 고른다', () => {
  const body = ['Authenticator', 'kakaostyle:cobi', '123456', 'other-service', '999999'].join('\n');
  assert.equal(parseOtp(body), '123456');
});

test('여러 계정 중 kakaostyle 계정의 코드만 고른다', () => {
  const body = ['github:someone', '111111', 'kakaostyle', '654321', 'aws', '222222'].join('\n');
  assert.equal(parseOtp(body), '654321');
});

test('계정 라벨과 코드 사이에 issuer 줄이 껴 있어도 3줄 안이면 찾는다', () => {
  const body = ['kakaostyle', 'Zigzag SSO', '012345'].join('\n');
  assert.equal(parseOtp(body), '012345');
});

test('대소문자를 구분하지 않는다', () => {
  const body = ['KakaoStyle Account', '445566'].join('\n');
  assert.equal(parseOtp(body), '445566');
});

test('kakaostyle 계정이 없으면 null', () => {
  const body = ['github:someone', '111111', 'aws', '222222'].join('\n');
  assert.equal(parseOtp(body), null);
});

test('6자리 코드가 없으면 null (자릿수 안 맞음)', () => {
  const body = ['kakaostyle', '12345', '1234567'].join('\n');
  assert.equal(parseOtp(body), null);
});

test('빈 문자열이면 null', () => {
  assert.equal(parseOtp(''), null);
});

test('코드가 계정 줄에서 4줄 이상 떨어져 있으면 못 찾는다 (윈도 밖)', () => {
  const body = ['kakaostyle', 'a', 'b', 'c', '123456'].join('\n');
  assert.equal(parseOtp(body), null);
});
