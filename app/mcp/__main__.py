"""独立启动 MCP 服务器：python -m app.mcp"""

from app.mcp.server import mcp


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
