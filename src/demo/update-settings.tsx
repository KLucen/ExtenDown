import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { version as buildVersion } from '../../package.json';

type UpdateResult =
  | { status: 'no-release' }
  | { status: 'up-to-date'; latestVersion: string }
  | { status: 'update-available'; latestVersion: string; tag: string; hasInstaller: boolean };

function resultMessage(result: UpdateResult): string {
  switch (result.status) {
    case 'no-release': return 'GitHub 暂无正式发布版本。';
    case 'up-to-date': return '当前版本已是最新版本。';
    case 'update-available': return result.hasInstaller
      ? `发现新版本 ${result.latestVersion}，可前往发布页下载安装包。`
      : `发现新版本 ${result.latestVersion}，发布页暂未提供适用于此平台的安装包。`;
  }
}

function checkError(reason: unknown): string {
  switch (reason) {
    case 'update-network': return '无法连接 GitHub，请检查网络后重试。';
    case 'update-rate-limited': return 'GitHub 暂时限制了请求，请稍后重试。';
    case 'update-invalid-release': return 'GitHub 发布信息中的版本号无效。';
    default: return '检查更新失败，请稍后重试。';
  }
}

export function UpdateSettings({ desktop }: { desktop: boolean }) {
  const [version, setVersion] = useState(buildVersion);
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState(false);
  const [result, setResult] = useState<UpdateResult>();
  const [error, setError] = useState('');

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void getVersion().then(value => { if (active) setVersion(value); }).catch(() => {});
    return () => { active = false; };
  }, [desktop]);

  async function check() {
    setChecking(true);
    setResult(undefined);
    setError('');
    try {
      setResult(await invoke<UpdateResult>('check_for_updates'));
    } catch (reason) {
      setError(checkError(reason));
    } finally {
      setChecking(false);
    }
  }

  async function openRelease(tag: string) {
    setOpening(true);
    setError('');
    try {
      await invoke('open_update_release', { tag });
    } catch {
      setError('无法在浏览器中打开 GitHub 发布页。');
    } finally {
      setOpening(false);
    }
  }

  return <section className="settings-section" aria-labelledby="update-settings-title">
    <div className="setting-field">
      <div>
        <h3 id="update-settings-title">版本与更新</h3>
        <p>当前版本 <strong>{version}</strong></p>
      </div>
      {desktop && <button className="setting-action" type="button" disabled={checking || opening}
        onClick={() => void check()}>{checking ? '正在检查…' : '检查更新'}</button>}
    </div>
    <p className="update-status" role="status">{checking ? '正在查询 GitHub Releases…' : result ? resultMessage(result) : null}</p>
    {error && <div className="error" role="alert">{error}</div>}
    {result?.status === 'update-available' && <button className="setting-action" type="button" disabled={opening}
      onClick={() => void openRelease(result.tag)}>查看发布页</button>}
  </section>;
}
