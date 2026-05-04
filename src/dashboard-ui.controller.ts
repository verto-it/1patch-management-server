// AGPL-3.0-only
import { Controller, Get, Header, NotFoundException, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';

const ASSETS: Record<string, { type: string }> = {
  'styles.css':     { type: 'text/css; charset=utf-8' },
  'app.bundle.js':  { type: 'text/javascript; charset=utf-8' },
};

const CATEGORIES = new Set([
  'overview',
  'devices',
  'apps',
  'packages',
  'rules',
  'tasks',
  'nodes',
  'alarms',
  'audit',
  'siem',
  'security-posture',
]);


@Controller()
export class DashboardUiController {
  private readonly assetRoot = join(__dirname, 'dashboard-ui');

  @Get('/ui')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  index() {
    return readFileSync(join(this.assetRoot, 'shell.html'), 'utf8');
  }

  @Get('/ui/:asset')
  asset(@Param('asset') asset: string, @Res() res: Response) {
    const meta = ASSETS[asset];
    if (!meta) {
      if (CATEGORIES.has(asset)) {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.send(readFileSync(join(this.assetRoot, 'shell.html'), 'utf8'));
        return;
      }
      throw new NotFoundException();
    }
    const content = readFileSync(join(this.assetRoot, asset), 'utf8');
    res.setHeader('content-type', meta.type);
    res.setHeader('cache-control', 'no-cache');
    res.send(content);
  }
}
