// AGPL-3.0-only
import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';

const ASSETS: Record<string, { type: string }> = {
  'styles.css':     { type: 'text/css; charset=utf-8' },
  'app.bundle.js':  { type: 'text/javascript; charset=utf-8' },
  'logo.svg':       { type: 'image/svg+xml; charset=utf-8' },
  'logo.png':       { type: 'image/png' },
};

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
      // Unknown segment — serve the SPA shell so the frontend router can
      // handle authentication and redirect unauthenticated users to login.
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.send(readFileSync(join(this.assetRoot, 'shell.html'), 'utf8'));
      return;
    }
    const content = readFileSync(join(this.assetRoot, asset));
    res.setHeader('content-type', meta.type);
    res.setHeader('cache-control', 'no-cache');
    res.send(content);
  }

  /**
   * Catch-all for nested UI paths like /ui/admin/users, /ui/devices/123, etc.
   * Always serves the SPA shell so the frontend router handles auth & routing.
   */
  @Get('/ui/*path')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  nestedUiPath() {
    return readFileSync(join(this.assetRoot, 'shell.html'), 'utf8');
  }
}
