from vigil.core.connectors.types import CmdResult
from vigil.plugins.base.disk_usage import (
    PSEUDO_FS_TYPES, df_command, du_command, parse_df, parse_du, path_key,
)


class TestPathKey:
    def test_root(self):
        assert path_key('/') == 'root'

    def test_nested_and_spaces(self):
        assert path_key('/mnt/my drive/') == 'mnt_my_drive'


class TestDfCommand:
    def test_one_path_in_bytes(self):
        assert (df_command(('size', 'pcent'), path='/data', byte_blocks=True)
                == "df -B1 --output=size,pcent /data")

    def test_path_is_shell_quoted(self):
        assert df_command(('pcent',), path="/it's here").endswith("'/it'\"'\"'s here'")

    def test_every_filesystem_with_excludes(self):
        cmd = df_command(('target', 'ipcent'), exclude_types=('tmpfs', 'proc'))
        assert cmd == "df -x tmpfs -x proc --output=target,ipcent"

    def test_pseudo_types_cover_tmpfs_and_overlay(self):
        assert {'tmpfs', 'overlay', 'proc'} <= set(PSEUDO_FS_TYPES)


class TestParseDf:
    _COLUMNS = ('target', 'size', 'used', 'pcent')

    def test_rows_skip_the_header(self):
        block = "Mounted on 1B-blocks Used Use%\n/ 100 40 40%\n/home 200 50 25%\n"
        assert parse_df(block, self._COLUMNS) == [
            {'target': '/', 'size': 100, 'used': 40, 'pcent': 40.0},
            {'target': '/home', 'size': 200, 'used': 50, 'pcent': 25.0},
        ]

    def test_mount_point_with_spaces(self):
        rows = parse_df("hdr\n/mnt/my drive 100 10 10%\n", self._COLUMNS)
        assert rows[0]['target'] == '/mnt/my drive'

    def test_unparseable_and_short_rows_are_skipped(self):
        block = "hdr\n/tank -\n/ 5%\ngarbage\n"
        assert parse_df(block, ('target', 'ipcent')) == [{'target': '/', 'ipcent': 5.0}]

    def test_headerless_single_path(self):
        rows = parse_df("100 40 60 40%\n", ('size', 'used', 'avail', 'pcent'), header=False)
        assert rows == [{'size': 100, 'used': 40, 'avail': 60, 'pcent': 40.0}]

    def test_empty_output(self):
        assert parse_df("", self._COLUMNS) == []


class TestDu:
    def test_command(self):
        assert du_command('/var/log', 30) == "timeout 30 du -sb /var/log"

    def test_size(self):
        assert parse_du(CmdResult(0, "2048\t/var/log\n", ""), 30) == (2048, None)

    def test_timeout(self):
        assert parse_du(CmdResult(124, "", ""), 30) == (None, "du timed out after 30s")

    def test_failure(self):
        assert parse_du(CmdResult(1, "", "du: cannot access\n"), 30) == (None, "du failed: du: cannot access")

    def test_garbage(self):
        size, error = parse_du(CmdResult(0, "", ""), 30)
        assert size is None and error.startswith("could not parse du output")
