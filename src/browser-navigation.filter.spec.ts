import { HttpStatus } from '@nestjs/common';
import { Request } from 'express';
import { dashboardLoginTarget, shouldRedirectToLogin } from './browser-navigation.filter';

function request(path: string, accept = 'text/html', method = 'GET') {
  return {
    method,
    path,
    header: (name: string) => name.toLowerCase() === 'accept' ? accept : undefined,
  } as Request;
}

describe('BrowserNavigationFilter', () => {
  it('redirects unauthenticated browser navigations for dashboard paths', () => {
    const req = request('/devices');

    expect(shouldRedirectToLogin(req, HttpStatus.UNAUTHORIZED)).toBe(true);
    expect(dashboardLoginTarget(req)).toBe('/ui/devices');
  });

  it('keeps API callers on normal JSON errors', () => {
    expect(shouldRedirectToLogin(request('/devices', 'application/json'), HttpStatus.UNAUTHORIZED)).toBe(false);
    expect(shouldRedirectToLogin(request('/devices', '*/*'), HttpStatus.UNAUTHORIZED)).toBe(false);
    expect(shouldRedirectToLogin(request('/devices', 'text/html', 'POST'), HttpStatus.UNAUTHORIZED)).toBe(false);
  });

  it('redirects unknown browser pages to the dashboard login screen', () => {
    const req = request('/missing-page');

    expect(shouldRedirectToLogin(req, HttpStatus.NOT_FOUND)).toBe(true);
    expect(dashboardLoginTarget(req)).toBe('/ui');
  });

  it('does not rewrite UI assets or UI routes', () => {
    expect(shouldRedirectToLogin(request('/ui/logo.svg'), HttpStatus.NOT_FOUND)).toBe(false);
    expect(shouldRedirectToLogin(request('/ui/devices'), HttpStatus.NOT_FOUND)).toBe(false);
  });
});
