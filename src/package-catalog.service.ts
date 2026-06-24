import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { MemoryStore } from './storage/memory.store';
import { PackageManager } from './types';
import { WINDOWS_CATALOG } from './catalog/windows.catalog';
import { LINUX_CATALOG } from './catalog/linux.catalog';

export interface CatalogEntry {
  packageId: string;
  name: string;
  publisher: string;
  category: string;
  platform: 'windows' | 'linux' | 'macos';
  packageManager: PackageManager;
}

@Injectable()
export class PackageCatalogService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PackageCatalogService.name);

  constructor(private readonly store: MemoryStore) {}

  async onApplicationBootstrap() {
    const before = this.store.packages.length;
    this.store.packages = this.store.packages.filter((p) => p.catalogSource !== 'central');
    const removed = before - this.store.packages.length;
    if (removed > 0) {
      await this.store.persist();
      this.logger.log(`Removed ${removed} auto-loaded central package(s) — packages are now user-selected via the catalog`);
    }
  }

  getCatalog(): CatalogEntry[] {
    return [...WINDOWS_CATALOG, ...LINUX_CATALOG];
  }
}
