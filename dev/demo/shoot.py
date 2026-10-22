"""Full-page screenshots of a running demo, in each colour scheme, for checking a UI change by eye."""
import argparse
import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

# The demo fleet's pages, by the name each screenshot is saved under.
PAGES = {
    'overview': '/',
    'events': '/events',
    'schedules': '/schedules',
    'group': '/monitor/Local%20Services',
    'http': '/monitor/self-http',
    'systemd': '/monitor/ws-nginx',
}


async def shoot(port: int, out_dir: Path, schemes: list, names: list, wait_ms: int) -> None:
    """Save <name>-<scheme>.png for every page and scheme asked for."""
    out_dir.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        for scheme in schemes:
            page = await browser.new_page(viewport={'width': 1440, 'height': 1000}, color_scheme=scheme)
            for name in names:
                path = PAGES.get(name, name)
                await page.goto(f'http://127.0.0.1:{port}{path}')
                # The dashboard fills in over its websocket after load, so a shot taken at once is half empty.
                await page.wait_for_timeout(wait_ms)
                file = out_dir / f"{name.strip('/').replace('/', '_') or 'root'}-{scheme}.png"
                await page.screenshot(path=str(file), full_page=True)
                print(file)
            await page.close()
        await browser.close()


def main() -> None:
    """Read the command line and take the screenshots it asks for."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8099)
    parser.add_argument('--out', type=Path, default=Path('demo-shots'))
    parser.add_argument('--schemes', default='light,dark', help='comma-separated: light, dark')
    parser.add_argument('--wait', type=int, default=6000, help='milliseconds to let a page fill in')
    parser.add_argument('pages', nargs='*', help=f"page names ({', '.join(PAGES)}) or paths; all by default")
    args = parser.parse_args()
    asyncio.run(shoot(args.port, args.out, args.schemes.split(','), args.pages or list(PAGES), args.wait))


if __name__ == '__main__':
    main()
