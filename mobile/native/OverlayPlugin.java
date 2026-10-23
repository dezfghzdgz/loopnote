package app.loopnote;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionConfig;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Most mezi appkou (JS) a bublinou přes ostatní aplikace. */
@CapacitorPlugin(name = "LoopnoteOverlay")
public class OverlayPlugin extends Plugin {
    static OverlayPlugin instance;
    static String pending = null; // výřez, který appka ještě nepřevzala

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null; // appka zavřená – výřez počká v "pending"
        super.handleOnDestroy();
    }

    @PluginMethod
    public void canDraw(PluginCall call) {
        JSObject r = new JSObject();
        r.put("value", Settings.canDrawOverlays(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void requestDraw(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (!Settings.canDrawOverlays(getContext())) {
            call.reject("overlay");
            return;
        }
        if (BubbleService.running) {
            call.resolve();
            return;
        }
        MediaProjectionManager m = (MediaProjectionManager) getContext().getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        // Android 14+: rovnou celá obrazovka (ne jen jedna aplikace)
        Intent ask = Build.VERSION.SDK_INT >= 34
                ? m.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
                : m.createScreenCaptureIntent();
        startActivityForResult(call, ask, "onCapturePermission");
    }

    @ActivityCallback
    private void onCapturePermission(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("denied");
            return;
        }
        Intent s = new Intent(getContext(), BubbleService.class);
        s.putExtra("code", result.getResultCode());
        s.putExtra("data", result.getData());
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(s);
        else getContext().startService(s);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), BubbleService.class));
        call.resolve();
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        JSObject r = new JSObject();
        r.put("value", BubbleService.running);
        call.resolve(r);
    }

    @PluginMethod
    public void takePending(PluginCall call) {
        JSObject r = new JSObject();
        if (pending != null) r.put("url", pending);
        pending = null;
        call.resolve(r);
    }

    /** Zavolá služba bubliny, když uživatel něco zakroužkoval. */
    static void deliver(String dataUrl) {
        pending = dataUrl;
        if (instance != null && instance.getBridge() != null) {
            JSObject o = new JSObject();
            o.put("url", dataUrl);
            instance.notifyListeners("circle", o, false);
            pending = null;
        }
    }
}
