"""Apply a reviewed deployment. Input only on stdin; never return secret-bearing output."""
import fcntl, hashlib, json, os, stat, subprocess, sys, tempfile

def digest(data):
    return hashlib.sha256(data).hexdigest()

def command(args, cwd, timeout=90):
    subprocess.run(args, cwd=cwd, check=True, timeout=timeout, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def private_file(filename, data):
    with os.fdopen(os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())

def rewrite(stream, content):
    stream.seek(0)
    stream.write(content)
    stream.truncate()
    stream.flush()
    os.fsync(stream.fileno())

def main():
    p = json.load(sys.stdin)
    root = p['root']
    cwd = os.path.dirname(p['composeFile'])
    compose = ['docker', 'compose', '--project-directory', cwd, '-p', p['project'], '-f', p['composeFile']]
    locked = []
    candidate = None
    applied = False
    root_created = False
    try:
        if p['fresh']:
            names = subprocess.check_output(['docker', 'ps', '-a', '--format', '{{.Names}}'], text=True).splitlines()
            if p['container'] in names:
                raise ValueError('A container now exists under this name. Reconnect and review again.')
        # A unique directory ensures existing secrets and ACME state are never overwritten.
        if os.path.lexists(root):
            raise ValueError('The setup directory already exists: ' + root + '. Inspect the prior setup before retrying; existing credentials and certificates were preserved.')
        for f in sorted(p['files'], key=lambda f: f['path']):
            if f['expected'] is None:
                if os.path.lexists(f['path']):
                    raise ValueError('A target file appeared since review. Review again.')
                continue
            stream = os.fdopen(os.open(f['path'], os.O_RDWR | os.O_NOFOLLOW), 'r+b')
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            before = stream.read()
            locked.append((f, stream, before, os.fstat(stream.fileno()).st_ino))
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode) or digest(before) != f['expected']:
                raise ValueError('Configuration changed since review. No files were updated; review again.')
        os.makedirs(os.path.dirname(root), mode=0o700, exist_ok=True)
        os.mkdir(root, mode=0o700)
        root_created = True
        os.mkdir(root + '/acme', mode=0o700)
        private_file(root + '/acme/acme.json', b'{}')
        private_file(root + '/cloudflare-token', p['secret'].encode())
        os.mkdir(root + '/backups', mode=0o700)
        for i, (f, stream, before, inode) in enumerate(locked):
            private_file(root + '/backups/' + str(i) + '.bak', before)
        private_file(root + '/backups/manifest.json', json.dumps([{'path': f['path'], 'backup': str(i) + '.bak'} for i, (f, _, _, _) in enumerate(locked)]).encode())
        # Compose validation uses the reviewed candidate in the original project directory.
        fd, candidate = tempfile.mkstemp(prefix='.traefikcop-review-', suffix='.yml', dir=cwd)
        compose_content = next(f['content'] for f in p['files'] if f['path'] == p['composeFile'])
        with os.fdopen(fd, 'w') as out:
            out.write(compose_content)
        command(['docker', 'compose', '--project-directory', cwd, '-p', p['project'], '-f', candidate, 'config', '--quiet'], cwd, 20)
        for f, stream, before, inode in locked:
            if os.stat(f['path']).st_ino != inode or digest(open(f['path'], 'rb').read()) != f['expected']:
                raise ValueError('A configuration file changed during setup. Review again.')
        applied = True
        for f in p['files']:
            existing = next((stream for item, stream, _, _ in locked if item is f), None)
            if existing:
                rewrite(existing, f['content'].encode())
            else:
                private_file(f['path'], f['content'].encode())
        if p['fresh']:
            command(compose + ['pull', p['service']], cwd, 120)
        command(compose + ['up', '-d', '--no-deps', '--no-build', '--force-recreate', '--pull', 'never', p['service']], cwd, 60)
        running = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.Running}}', p['container']], text=True).strip()
        if running != 'true':
            raise RuntimeError('Container is not running')
        print(json.dumps({'ok': True}))
    except Exception as error:
        restored = False
        if applied and locked:
            try:
                for f, stream, before, inode in locked:
                    rewrite(stream, before)
                command(compose + ['up', '-d', '--no-deps', '--no-build', '--force-recreate', '--pull', 'never', p['service']], cwd, 60)
                restored = True
            except Exception:
                pass
        if isinstance(error, ValueError):
            message = str(error)
        elif restored:
            message = 'Setup failed. Original files were restored and the original Compose service was recreated. Backups are in ' + root + '/backups.'
        elif applied:
            message = 'Setup did not finish. Inspect the container and files in ' + root + ' before retrying. Saved backups are in its backups directory.'
        else:
            message = 'Setup validation failed. Check Compose, file permissions, and Docker access. Existing configuration was not changed.'
        if root_created and not applied:
            # These contain only newly created setup files; do not leave a failed preflight blocking retries.
            import shutil
            shutil.rmtree(root)
        print(json.dumps({'ok': False, 'error': message}))
    finally:
        if candidate and os.path.exists(candidate):
            os.unlink(candidate)
        for _, stream, _, _ in locked:
            stream.close()

try:
    main()
except Exception:
    print(json.dumps({'ok': False, 'error': 'Remote setup could not start. Check Python 3, Docker Compose, and file permissions.'}))
