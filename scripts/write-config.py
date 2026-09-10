"""Compare-and-write a mounted config without replacing its inode. Payload is stdin."""
import fcntl, hashlib, json, os, stat, sys

def digest(data):
    return hashlib.sha256(data).hexdigest()

def main():
    payload = json.load(sys.stdin)
    filename = payload['path']
    content = payload['content'].encode()
    if len(content) > 2 * 1024 * 1024:
        raise ValueError('Configuration is too large')
    flags = os.O_RDWR | os.O_NOFOLLOW
    fd = os.open(filename, flags)
    with os.fdopen(fd, 'r+b') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        before_stat = os.fstat(stream.fileno())
        if not stat.S_ISREG(before_stat.st_mode):
            raise ValueError('Target is not a regular file')
        original = stream.read()
        if digest(original) != payload['expected']:
            print(json.dumps({'ok': False, 'conflict': True}))
            return
        history = os.path.join(os.path.dirname(filename), '.traefikcop-history')
        os.makedirs(history, mode=0o700, exist_ok=True)
        if os.path.islink(history):
            raise ValueError('History directory must not be a symlink')
        os.chmod(history, 0o700)
        revision = payload['revision']
        if not revision.isalnum():
            raise ValueError('Invalid revision identifier')
        backup = os.path.join(history, revision + '.bak')
        backup_fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(backup_fd, 'wb') as out:
            out.write(original)
            out.flush()
            os.fsync(out.fileno())
        if os.stat(filename).st_ino != before_stat.st_ino:
            raise ValueError('File was replaced during save')
        try:
            stream.seek(0)
            stream.write(content)
            stream.truncate()
            stream.flush()
            os.fsync(stream.fileno())
            stream.seek(0)
            if digest(stream.read()) != digest(content):
                raise IOError('Verification failed')
        except Exception:
            stream.seek(0)
            stream.write(original)
            stream.truncate()
            stream.flush()
            os.fsync(stream.fileno())
            raise
        print(json.dumps({'ok': True, 'hash': digest(content), 'backup': backup}))

try:
    main()
except Exception:
    # Do not expose configuration contents or credential values in errors.
    print(json.dumps({'ok': False, 'error': 'Remote write failed. Check file permissions and disk space; inspect the saved backup before retrying.'}))
