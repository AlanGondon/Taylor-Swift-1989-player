from pathlib import Path
import base64
import json

assets = Path(r"C:\Users\张志铭\Desktop\1989-album-site\assets")


def data_url(name, mime):
    raw = (assets / name).read_bytes()
    return f"data:{mime};base64," + base64.b64encode(raw).decode("ascii")


payload = {
    "cover": data_url("cover-source.jpg", "image/jpeg"),
    "clean": data_url("cover-clean.jpg", "image/jpeg"),
    "ink": data_url("ink-1989.webp", "image/webp"),
    "writeMap": data_url("write-map.png", "image/png"),
}
header = (
    "// Generated from the supplied cover. Every texture is embedded so the\n"
    "// experience also works when index.html is opened directly from disk.\n"
    "window.ALBUM_TEXTURES = "
)
(assets / "textures.js").write_text(
    header + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
    encoding="utf-8",
)
print("textures.js", (assets / "textures.js").stat().st_size, "bytes")
