# Přidá do vygenerovaného Android projektu bublinu přes ostatní aplikace (plugin LoopnoteOverlay).
# Spouští GitHub Actions po "npx cap add android". S parametrem --remove ji zase odebere (záložní build).
import os, re, shutil, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "mobile", "android", "app", "src", "main")
JAVA = os.path.join(APP, "java", "app", "loopnote")
MAN = os.path.join(APP, "AndroidManifest.xml")
SRC = os.path.join(ROOT, "mobile", "native")
PERMS = ["android.permission.RECORD_AUDIO", "android.permission.MODIFY_AUDIO_SETTINGS", "android.permission.SYSTEM_ALERT_WINDOW",
         "android.permission.FOREGROUND_SERVICE", "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION", "android.permission.POST_NOTIFICATIONS"]
SERVICE = '<service android:name=".BubbleService" android:exported="false" android:foregroundServiceType="mediaProjection" />'
m = open(MAN, encoding="utf-8").read()
if "--remove" in sys.argv:
    for f in ("OverlayPlugin.java", "BubbleService.java"):
        p = os.path.join(JAVA, f)
        if os.path.exists(p): os.remove(p)
    open(os.path.join(JAVA, "MainActivity.java"), "w").write("package app.loopnote;\n\nimport com.getcapacitor.BridgeActivity;\n\npublic class MainActivity extends BridgeActivity {}\n")
    m = m.replace("        " + SERVICE + "\n", "")
    open(MAN, "w", encoding="utf-8").write(m)
    print("Android bubble removed (fallback build)")
    sys.exit(0)
os.makedirs(JAVA, exist_ok=True)
for f in ("MainActivity.java", "OverlayPlugin.java", "BubbleService.java"):
    shutil.copy(os.path.join(SRC, f), os.path.join(JAVA, f))
for p in PERMS:
    if p not in m:
        m = m.replace("</manifest>", f'    <uses-permission android:name="{p}" />\n</manifest>')
if "BubbleService" not in m:
    m = re.sub(r"(\s*)</application>", r"\n        " + SERVICE + r"\1</application>", m, count=1)
open(MAN, "w", encoding="utf-8").write(m)
print("Android bubble added")
