import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';

const DASHBOARD_PATHS = new Set([
  'overview',
  'devices',
  'device-groups',
  'apps',
  'packages',
  'rules',
  'tasks',
  'nodes',
  'alarms',
  'audit',
]);

/**
 * Redirect browser navigations that miss authentication into the dashboard SPA.
 * API callers keep receiving normal JSON errors.
 */
@Catch(HttpException)
export class BrowserNavigationFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const request = context.getRequest<Request>();
    const response = context.getResponse<Response>();
    const status = exception.getStatus();

    if (shouldRedirectToLogin(request, status)) {
      response.redirect(HttpStatus.FOUND, dashboardLoginTarget(request));
      return;
    }

    const exceptionResponse = exception.getResponse();
    const body = typeof exceptionResponse === 'object'
      ? exceptionResponse
      : { statusCode: status, message: exceptionResponse };
    response.status(status).json(body);
  }
}

export function shouldRedirectToLogin(request: Request, status: number) {
  if (request.method !== 'GET') return false;
  if (status !== HttpStatus.UNAUTHORIZED && status !== HttpStatus.NOT_FOUND) return false;

  const accept = request.header('accept') ?? '';
  if (!accept.toLowerCase().includes('text/html')) return false;

  const path = request.path || '/';
  if (path.startsWith('/ui')) return false;
  if (/\.[a-z0-9]{1,12}$/i.test(path)) return false;

  return true;
}

export function dashboardLoginTarget(request: Request) {
  const path = request.path || '/';
  const parts = path.split('/').filter(Boolean);
  const first = parts[0];

  if (first === 'admin') {
    return `/ui/admin/${encodeURIComponent(parts[1] || 'policy')}`;
  }

  if (DASHBOARD_PATHS.has(first)) {
    return first === 'overview' ? '/ui' : `/ui/${encodeURIComponent(first)}`;
  }

  return '/ui';
}
