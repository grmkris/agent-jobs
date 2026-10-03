"""G1 snapshot and fresh-deploy input. Invoked by the chain-guarded, launch-locked shell wrapper."""
import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile

G1_IDENTITY = {
    'addresses': {
        'deployment.core': '0x8BFFD7CCB6435b95f7c50ec451a024127b73be9D',
        'deployment.factory': '0x6693184AA777A30D293B5fAf168B038eF858ea6B',
        'deployment.hireling.safe': '0x1006582a6d0C40E19eAbd1847C652D48b88BD5bF',
        'deployment.hireling.factory': '0x6693184AA777A30D293B5fAf168B038eF858ea6B',
        'deployment.hireling.vault': '0xcc91Fdb6d33d2F074F3c6617265B2d46B755f0Bd',
        'deployment.hireling.feeSchedule': '0x143EBFbB2be971BaBc5679D4826b905aE1876C4B',
        'deployment.hireling.distributor': '0xA6DfBDCb510b4c9A45B979f4d37D80fDa93b0dcb',
        'deployment.hireling.miningReserve': '0x1a8b9FbF1Fa9d6dDCE39836D12fca6901547a9CE',
        'deployment.hireling.teamVesting': '0xC677750BE0358a7A3C43Ff92157427159E5012F0',
        'deployment.main.holding': '0x9BB0B3a6c130d81f6820499bD168C4d910CD502F',
        'deployment.main.evaluator': '0x8edc23B454696D8f531cE8f4EA1D1eFf47901d0D',
        'deployment.main.factory': '0x6693184AA777A30D293B5fAf168B038eF858ea6B',
        'hireling.safe': '0x1006582a6d0C40E19eAbd1847C652D48b88BD5bF',
        'hireling.defaultArbitrator': '0x0E616916682E3DB0bFFe188Be07513CbB829ebC5',
    },
    'hirelingBlock': 67773705,
    't0': 1791013711,
    'clocks': {'minReviewWindow': 120, 'minDisputeWindow': 120, 'minArbitrationWindow': 300,
               'unstakeDelay': 600, 'holdingDelay': 900, 'feeDelay': 300, 'proposalGrace': 1800,
               'epochZeroDuration': 1800, 'epochDuration': 3600},
}
REASON = ('G1 archived for the G1b fast-clock redeploy (D24). G1 is not a legacy stack: '
          'legacy Hireling v1 would need its own protocol block. Dated G1 evidence remains in reality-check.md.')


def refuse(message):
    raise ValueError(message)


def plan(source, identity):
    config = json.loads(source)
    if not isinstance(config, dict) or config.get('chainId') != 10143 or config.get('network') != 'monad-testnet':
        refuse('config must be monad-testnet, chain 10143')
    if 'archive' in config:
        refuse('input is already an archive')
    for dotted, expected in identity['addresses'].items():
        value = config
        for key in dotted.split('.'):
            value = value.get(key) if isinstance(value, dict) else None
        if not isinstance(value, str) or value.lower() != expected.lower():
            refuse('G1 identity mismatch: ' + dotted)
    deployment = config['deployment']
    if (deployment['hireling'].get('block') != identity['hirelingBlock'] or
            deployment['hireling'].get('t0') != identity['t0'] or
            deployment['main'].get('kind') != 'hireling-v1'):
        refuse('G1 deployment metadata mismatch')
    if config['hireling'].get('clocks') != identity['clocks'] or config['hireling'].get('reuseCore') is not True:
        refuse('approved fast clocks and reused core are required')
    legacy = deployment.get('legacy', {})
    required = {'main-v1', 'main-v2', 'main-v3', 'demo-v1', 'demo-v2'}
    pair_keys = {'holding', 'evaluator', 'openTokens', 'kind', 'factory'}
    if (not isinstance(legacy, dict) or not required.issubset(legacy) or
            any(not isinstance(v, dict) or v.get('kind') != 'legacy' or not v.get('factory') or
                not set(v).issubset(pair_keys) for v in legacy.values())):
        refuse('expected legacy pairs with explicit legacy kind/FACTORY are required')
    # Odd-token receipts are G1-only output; the input stays. HirelingOutput rejects this deployment key, and
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


def prepare(config_path, archive_path, check=False):
    if os.path.lexists(archive_path):
        refuse('archive already exists; reconcile it manually, never overwrite')
    if not stat.S_ISREG(config_path.lstat().st_mode):
        refuse('config must be a regular file, not a symlink')
    source = config_path.read_bytes()
    prepared = plan(source, G1_IDENTITY)
    if check:
        print('PREP CHECK PASS: archive G1; remove deployment.hireling/main/oddTokens; preserve all other inputs and legacy pairs')
        return
    metadata = {'reason': REASON, 'date': datetime.now(timezone.utc).isoformat(),
                'sourceSha256': hashlib.sha256(source).hexdigest()}
    # Reuse the original JSON bytes up to its final object brace: every G1 record, role and address remains verbatim.
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
        with tempfile.NamedTemporaryFile(dir=config_path.parent, prefix='.prepare-g1b-', delete=False) as output:
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
    print('PREP DONE: G1 archived; active main absent until verified G1b promotion')
    print('archive: ' + str(archive_path))
    print('config: ' + str(config_path))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('config/monad-testnet.json'))
    parser.add_argument('--archive', type=Path, default=Path('config/archive/monad-testnet-g1.json'))
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        prepare(args.config, args.archive, args.check)
    except (ValueError, OSError, KeyError, TypeError) as error:
        # No RPC URL, key or config dump is included; only local paths and fixed validation labels.
        parser.exit(2, 'refusing: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
