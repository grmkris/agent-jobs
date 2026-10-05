"""Reviewed testnet snapshot and fresh-deploy input. Invoked by the chain-guarded, launch-locked shell wrapper."""
import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile

IDENTITIES = json.loads(Path(__file__).with_name('redeploy-identities.json').read_text())
G1_IDENTITY = IDENTITIES['g1']


def refuse(message):
    raise ValueError(message)


def address_at(config, dotted):
    value = config
    for key in dotted.split('.'):
        if isinstance(value, dict):
            value = value.get(key)
        elif isinstance(value, list) and key.isdecimal() and int(key) < len(value):
            value = value[int(key)]
        else:
            return None
    return value


def plan(source, identity):
    config = json.loads(source)
    if not isinstance(config, dict) or config.get('chainId') != 10143 or config.get('network') != 'monad-testnet':
        refuse('config must be monad-testnet, chain 10143')
    if 'archive' in config:
        refuse('input is already an archive')
    for dotted, expected in identity['addresses'].items():
        value = address_at(config, dotted)
        if not isinstance(value, str) or value.lower() != expected.lower():
            refuse('Reviewed identity mismatch: ' + dotted)
    deployment = config['deployment']
    if (deployment['hireling'].get('block') != identity['hirelingBlock'] or
            deployment['hireling'].get('t0') != identity['t0'] or
            deployment['main'].get('kind') != 'hireling-v1'):
        refuse('Reviewed deployment metadata mismatch')
    if config['hireling'].get('clocks') != identity['clocks'] or config['hireling'].get('reuseCore') is not True:
        refuse('approved fast clocks and reused core are required')
    legacy = deployment.get('legacy', {})
    required = {'main-v1', 'main-v2', 'main-v3', 'demo-v1', 'demo-v2'}
    pair_keys = {'holding', 'evaluator', 'openTokens', 'kind', 'factory'}
    if (not isinstance(legacy, dict) or not required.issubset(legacy) or
            any(not isinstance(v, dict) or v.get('kind') != 'legacy' or not v.get('factory') or
                not set(v).issubset(pair_keys) for v in legacy.values())):
        refuse('expected legacy pairs with explicit legacy kind/FACTORY are required')
    # Odd-token receipts belong to the retiring generation; the input stays. HirelingOutput rejects this deployment key, and
    # launch-testnet deploys new odd tokens. Keep the old addresses in the archive, never silently lose them.
    prepared = copy.deepcopy(config)
    for key in ('hireling', 'main', 'oddTokens'):
        prepared['deployment'].pop(key, None)
    accepted = {'block', 'core', 'network', 'factory', 'poolFactory', 'rewardTokens', 'stacksBlock', 'legacy'}
    if not set(prepared['deployment']).issubset(accepted):
        refuse('unknown deployment output; cannot prepare faithfully')
    if not isinstance(config.get('oddTokens'), dict) or not isinstance(config.get('liquidity'), dict):
        refuse('oddTokens and liquidity input blocks are required')
    return prepared


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def prepare(config_path, archive_path, *, from_name, check=False):
    identity = IDENTITIES[from_name]
    next_name = identity['next']
    if os.path.lexists(archive_path):
        refuse('archive already exists; reconcile it manually, never overwrite')
    if not stat.S_ISREG(config_path.lstat().st_mode):
        refuse('config must be a regular file, not a symlink')
    source = config_path.read_bytes()
    prepared = plan(source, identity)
    if check:
        print(f'PREP CHECK PASS: archive {from_name}; remove deployment.hireling/main/oddTokens; preserve all other inputs and legacy pairs')
        return
    metadata = {'reason': identity['reason'], 'date': datetime.now(timezone.utc).isoformat(),
                'sourceSha256': hashlib.sha256(source).hexdigest()}
    # Reuse the original JSON bytes up to its final object brace: every retiring record, role and address remains verbatim.
    end = source.rstrip()
    if not end.endswith(b'}'):
        refuse('input must be a JSON object')
    archive = end[:-1] + b',\n  "archive": ' + json.dumps(metadata, indent=2).encode() + b'\n}\n'
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with archive_path.open('xb') as output:
        output.write(archive)
        output.flush()
        os.fsync(output.fileno())
    sync_directory(archive_path.parent)
    # Archive is durable before replacing the active config. A crash or concurrent config edit leaves the snapshot
    # for manual reconciliation and a rerun refuses; it never guesses that preparation or launch succeeded.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=config_path.parent, prefix=f'.prepare-{next_name}-', delete=False) as output:
            temporary = Path(output.name)
            os.fchmod(output.fileno(), stat.S_IMODE(config_path.stat().st_mode))
            output.write((json.dumps(prepared, indent=2) + '\n').encode())
            output.flush()
            os.fsync(output.fileno())
        if config_path.read_bytes() != source:
            refuse('config changed during preparation; archive saved, active config untouched')
        os.replace(temporary, config_path)
        temporary = None
        sync_directory(config_path.parent)
    finally:
        if temporary is not None:
            temporary.unlink()
    print(f'PREP DONE: {from_name} archived; active main absent until verified {next_name} promotion')
    print('archive: ' + str(archive_path))
    print('config: ' + str(config_path))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('config/monad-testnet.json'))
    parser.add_argument('--from', dest='from_name', choices=sorted(IDENTITIES), required=True)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        archive = args.archive or Path(f'config/archive/monad-testnet-{args.from_name}.json')
        prepare(args.config, archive, check=args.check, from_name=args.from_name)
    except (ValueError, OSError, KeyError, TypeError) as error:
        # No RPC URL, key or config dump is included; only local paths and fixed validation labels.
        parser.exit(2, 'refusing: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
