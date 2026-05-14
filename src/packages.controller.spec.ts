import { PackagesController } from './packages.controller';
import { PackageArtifact, User } from './types';

const user: User = {
  id: 'admin-1',
  email: 'admin@example.com',
  passwordHash: '',
  roles: ['admin'],
  mfaEnabled: true,
  recoveryCodeHashes: [],
  failedAttempts: 0,
  oauthLinks: [],
};

function makeController() {
  const store: any = {
    packages: [],
    installedApps: [],
    devices: [],
    tasks: [],
    persist: jest.fn(),
  };
  const audit = { record: jest.fn() };
  const nodes = { availableNode: jest.fn(() => ({ id: 'node-1' })) };
  const authorization = { autoSignTask: jest.fn((task) => task) };
  return {
    controller: new PackagesController(store, audit as any, nodes as any, authorization as any),
    store,
    authorization,
  };
}

describe('PackagesController Linux apt support', () => {
  it('creates repo-managed apt artifacts as linux packages only', async () => {
    const { controller } = makeController();

    const artifact = await controller.create({
      name: 'OpenSSL',
      publisher: 'Ubuntu',
      version: '3.0.13',
      type: 'apt',
      packageId: 'openssl',
    }, user);

    expect(artifact).toEqual(expect.objectContaining({
      platform: 'linux',
      type: 'apt',
      packageId: 'openssl',
      installArgs: '',
      sourceUrl: undefined,
      sha256: undefined,
    }));
  });

  it('rejects apt artifacts with downloaded package metadata', async () => {
    const { controller } = makeController();

    await expect(controller.create({
      name: 'OpenSSL',
      publisher: 'Ubuntu',
      version: '3.0.13',
      type: 'apt',
      packageId: 'openssl',
      sourceUrl: 'https://packages.example/openssl.deb',
      sha256: 'abc',
    }, user)).rejects.toThrow('repo-managed');
  });

  it('rejects deploying linux packages to windows devices', async () => {
    const { controller, store } = makeController();
    store.devices.push({ id: 'win-1', tenantId: 'default', hostname: 'win-1', os: 'windows', publicKey: 'pk', preferredNodeId: 'node-1' });
    store.packages.push(aptArtifact('pkg-1'));

    await expect(controller.deployDevice('pkg-1', 'win-1', user)).rejects.toThrow('cannot be deployed');
  });

  it('deploy-all filters targets by package platform', async () => {
    const { controller, store, authorization } = makeController();
    store.devices.push(
      { id: 'linux-1', tenantId: 'default', hostname: 'linux-1', os: 'ubuntu', publicKey: 'pk', preferredNodeId: 'node-1' },
      { id: 'win-1', tenantId: 'default', hostname: 'win-1', os: 'windows', publicKey: 'pk', preferredNodeId: 'node-1' },
    );
    store.installedApps.push(
      { deviceId: 'linux-1', name: 'OpenSSL', publisher: 'Ubuntu', version: '3.0.12', packageId: 'openssl' },
      { deviceId: 'win-1', name: 'OpenSSL', publisher: 'Vendor', version: '3.0.12', packageId: 'Vendor.OpenSSL' },
    );
    store.packages.push(aptArtifact('pkg-1'));

    const result = await controller.deployAll('pkg-1', user);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toEqual(expect.objectContaining({ deviceId: 'linux-1', packageId: 'openssl' }));
    expect(result.skippedDeviceCount).toBe(1);
    expect(authorization.autoSignTask).toHaveBeenCalledTimes(1);
  });
});

function aptArtifact(id: string): PackageArtifact {
  return {
    id,
    name: 'OpenSSL',
    publisher: 'Ubuntu',
    version: '3.0.13',
    architecture: 'x64',
    platform: 'linux',
    type: 'apt',
    packageId: 'openssl',
    signatureStatus: 'unknown',
    installArgs: '',
    applicability: { appName: 'OpenSSL' },
    createdAt: new Date().toISOString(),
  };
}
