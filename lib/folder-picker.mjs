import { spawn } from 'node:child_process';

/** The native picker runs only after the user presses the folder button. */
export function chooseFolder(initialPath = '') {
  if (process.platform !== 'win32') {
    return Promise.resolve({ cancelled: true, manualEntry: true });
  }

  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $picker = New-Object System.Windows.Forms.FolderBrowserDialog
    $picker.Description = 'Commit Bloom - select a Git repository'
    $picker.ShowNewFolderButton = $false
    if ($env:COMMIT_BLOOM_INITIAL_DIR -and (Test-Path -LiteralPath $env:COMMIT_BLOOM_INITIAL_DIR)) {
      $picker.SelectedPath = $env:COMMIT_BLOOM_INITIAL_DIR
    }
    if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
      [Console]::Write($picker.SelectedPath)
    }
    $picker.Dispose()
  `;

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
      windowsHide: true,
      shell: false,
      env: { ...process.env, COMMIT_BLOOM_INITIAL_DIR: initialPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let errors = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Не удалось открыть выбор папки. Введите путь вручную. ${errors.trim()}`));
      } else {
        const path = output.trim();
        resolve(path ? { path } : { cancelled: true });
      }
    });
  });
}
