package app.loopnote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Plovoucí bublina Loopnote nad ostatními aplikacemi.
 * Ťuknutí = zakroužkuješ cokoli na obrazovce (obrazovka pod tím běží dál), výřez se pošle do appky.
 * Trojité ťuknutí = bublina se vypne (zapneš ji znovu v appce).
 */
public class BubbleService extends Service {
    static boolean running = false;
    private static final String CHANNEL = "loopnote_bubble";

    private final Handler main = new Handler(Looper.getMainLooper());
    private WindowManager wm;
    private BubbleView bubble;
    private WindowManager.LayoutParams bp;
    private DrawView overlay;
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private int sw, sh, dpi;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startAsForeground();
        if (projection == null) {
            int code = intent.getIntExtra("code", 0);
            Intent data;
            if (Build.VERSION.SDK_INT >= 33) data = intent.getParcelableExtra("data", Intent.class);
            else data = intent.getParcelableExtra("data");
            MediaProjectionManager m = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            try {
                projection = m.getMediaProjection(code, data);
            } catch (Exception e) {
                projection = null;
            }
            if (projection == null) {
                stopSelf();
                return START_NOT_STICKY;
            }
            projection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    main.post(() -> stopSelf());
                }
            }, main);
            measure();
            reader = ImageReader.newInstance(sw, sh, PixelFormat.RGBA_8888, 2);
            // jedno virtuální zobrazení na celou dobu (Android 14 nedovolí vytvořit další); mezi výřezy se jen pozastaví
            display = projection.createVirtualDisplay("loopnote", sw, sh, dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, main);
            main.postDelayed(() -> { if (display != null) display.setSurface(null); }, 400);
        }
        if (bubble == null) addBubble();
        running = true;
        return START_NOT_STICKY;
    }

    /** Skutečná velikost celého displeje včetně lišt (pro přesný výřez). */
    @SuppressWarnings("deprecation")
    private void measure() {
        DisplayMetrics dm = new DisplayMetrics();
        WindowManager w = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        if (Build.VERSION.SDK_INT >= 30) {
            Rect b = w.getMaximumWindowMetrics().getBounds();
            sw = b.width();
            sh = b.height();
            dpi = getResources().getDisplayMetrics().densityDpi;
        } else {
            w.getDefaultDisplay().getRealMetrics(dm);
            sw = dm.widthPixels;
            sh = dm.heightPixels;
            dpi = dm.densityDpi;
        }
    }

    /** Otočení displeje: přizpůsobit virtuální zobrazení (nové vytvořit Android 14 nedovolí, změnit velikost ano). */
    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        if (display == null) return;
        int ow = sw, oh = sh;
        measure();
        if (ow == sw && oh == sh) return;
        ImageReader old = reader;
        reader = ImageReader.newInstance(sw, sh, PixelFormat.RGBA_8888, 2);
        display.resize(sw, sh, dpi);
        display.setSurface(null);
        if (old != null) old.close();
    }

    private void startAsForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Loopnote bubble", NotificationManager.IMPORTANCE_LOW);
            nm.createNotificationChannel(ch);
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification.Builder nb = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Notification n = nb.setContentTitle("Loopnote")
                .setContentText("Bubble is on – tap it to circle anything. Triple-tap hides it.")
                .setSmallIcon(getApplicationInfo().icon)
                .setContentIntent(pi)
                .setOngoing(true)
                .build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(7, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(7, n);
    }

    private int overlayType() {
        return Build.VERSION.SDK_INT >= 26 ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY : WindowManager.LayoutParams.TYPE_PHONE;
    }

    private void addBubble() {
        wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        bubble = new BubbleView(this);
        int size = (int) (60 * getResources().getDisplayMetrics().density);
        bp = new WindowManager.LayoutParams(size, size, overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        bp.gravity = Gravity.TOP | Gravity.START;
        bp.x = sw - size - (int) (12 * getResources().getDisplayMetrics().density);
        bp.y = (int) (sh * 0.6);
        bubble.setOnTouchListener(new View.OnTouchListener() {
            float sx, sy;
            int ox, oy;
            boolean moved;
            long[] taps = new long[3];
            int nt = 0;
            final Runnable single = () -> startCircle();

            @Override
            public boolean onTouch(View v, MotionEvent e) {
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        sx = e.getRawX(); sy = e.getRawY(); ox = bp.x; oy = bp.y; moved = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = e.getRawX() - sx, dy = e.getRawY() - sy;
                        if (!moved && Math.hypot(dx, dy) < 12) return true;
                        moved = true;
                        bp.x = ox + (int) dx; bp.y = oy + (int) dy;
                        try { wm.updateViewLayout(bubble, bp); } catch (Exception ignored) { }
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (moved) return true;
                        long now = System.currentTimeMillis();
                        if (nt > 0 && now - taps[0] > 900) nt = 0;
                        if (nt < 3) taps[nt++] = now;
                        main.removeCallbacks(single);
                        if (nt >= 3) { nt = 0; stopSelf(); return true; }
                        main.postDelayed(single, 330);
                        return true;
                }
                return false;
            }
        });
        wm.addView(bubble, bp);
    }

    private void startCircle() {
        if (overlay != null) return;
        bubble.setVisibility(View.GONE);
        overlay = new DrawView(this);
        WindowManager.LayoutParams p = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT, overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        p.gravity = Gravity.TOP | Gravity.START;
        wm.addView(overlay, p);
    }

    private void endCircle(RectF r) {
        int[] loc = new int[2];
        if (overlay != null) {
            overlay.getLocationOnScreen(loc);
            try { wm.removeView(overlay); } catch (Exception ignored) { }
            overlay = null;
        }
        if (r == null) { bubble.setVisibility(View.VISIBLE); return; }
        final Rect rect = new Rect((int) r.left + loc[0], (int) r.top + loc[1], (int) r.right + loc[0], (int) r.bottom + loc[1]);
        // počkat, až čára zmizí, pak vyfotit jen zakroužkované místo
        drainReader();
        display.setSurface(reader.getSurface());
        main.postDelayed(() -> grab(rect, 0), 260);
    }

    private void drainReader() {
        try { Image old; while ((old = reader.acquireLatestImage()) != null) old.close(); } catch (Exception ignored) { }
    }

    private void grab(Rect rect, int attempt) {
        Image img = null;
        try { img = reader.acquireLatestImage(); } catch (Exception ignored) { }
        if (img == null) {
            if (attempt < 8) { main.postDelayed(() -> grab(rect, attempt + 1), 120); return; }
            display.setSurface(null);
            bubble.setVisibility(View.VISIBLE);
            return;
        }
        String url = null;
        try {
            Image.Plane pl = img.getPlanes()[0];
            ByteBuffer buf = pl.getBuffer();
            int ps = pl.getPixelStride(), rs = pl.getRowStride(), iw = img.getWidth(), ih = img.getHeight();
            Bitmap full = Bitmap.createBitmap(iw + (rs - ps * iw) / ps, ih, Bitmap.Config.ARGB_8888);
            full.copyPixelsFromBuffer(buf);
            // souřadnice kroužku jsou v pixelech displeje, snímek má rozměr celého displeje (sw × sh)
            float kx = (float) iw / Math.max(1, sw), ky = (float) ih / Math.max(1, sh);
            int x = Math.max(0, (int) (rect.left * kx)), y = Math.max(0, (int) (rect.top * ky));
            int w = Math.min(iw - x, (int) (rect.width() * kx)), h = Math.min(ih - y, (int) (rect.height() * ky));
            if (w > 8 && h > 8) {
                Bitmap crop = Bitmap.createBitmap(full, x, y, w, h);
                float k = Math.min(1f, 1600f / Math.max(w, h));
                if (k < 1f) crop = Bitmap.createScaledBitmap(crop, Math.round(w * k), Math.round(h * k), true);
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                crop.compress(Bitmap.CompressFormat.JPEG, 85, out);
                url = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
            }
        } catch (Exception ignored) {
        } finally {
            img.close();
            display.setSurface(null);
        }
        bubble.setVisibility(View.VISIBLE);
        if (url == null) return;
        OverlayPlugin.deliver(url);
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open != null) {
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            try { startActivity(open); } catch (Exception ignored) { }
        }
    }

    @Override
    public void onDestroy() {
        running = false;
        try { if (overlay != null) wm.removeView(overlay); } catch (Exception ignored) { }
        try { if (bubble != null) wm.removeView(bubble); } catch (Exception ignored) { }
        overlay = null;
        bubble = null;
        if (display != null) display.release();
        if (reader != null) reader.close();
        if (projection != null) projection.stop();
        display = null;
        reader = null;
        projection = null;
        super.onDestroy();
    }

    /** Kulatá bublina s logem (kroužek a žlutá tečka). */
    static class BubbleView extends View {
        final Paint bg = new Paint(Paint.ANTI_ALIAS_FLAG), ring = new Paint(Paint.ANTI_ALIAS_FLAG), dot = new Paint(Paint.ANTI_ALIAS_FLAG);

        BubbleView(Context c) {
            super(c);
            bg.setColor(Color.rgb(15, 124, 107));
            ring.setColor(Color.WHITE);
            ring.setStyle(Paint.Style.STROKE);
            ring.setStrokeCap(Paint.Cap.ROUND);
            dot.setColor(Color.rgb(255, 212, 59));
        }

        @Override
        protected void onDraw(Canvas c) {
            float w = getWidth(), h = getHeight(), r = Math.min(w, h) / 2f;
            c.drawCircle(w / 2, h / 2, r * 0.92f, bg);
            ring.setStrokeWidth(r * 0.16f);
            c.drawArc(new RectF(w / 2 - r * 0.45f, h / 2 - r * 0.45f, w / 2 + r * 0.45f, h / 2 + r * 0.45f), 300, 300, false, ring);
            c.drawCircle(w / 2 + r * 0.42f, h / 2 - r * 0.42f, r * 0.14f, dot);
        }
    }

    /** Průhledná vrstva přes celou obrazovku: kreslíš kroužek, pod tím vše běží dál. */
    class DrawView extends View {
        final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG), halo = new Paint(Paint.ANTI_ALIAS_FLAG), hint = new Paint(Paint.ANTI_ALIAS_FLAG), pill = new Paint(Paint.ANTI_ALIAS_FLAG);
        final Path path = new Path();
        float minX, minY, maxX, maxY;
        boolean drawing = false;

        DrawView(Context c) {
            super(c);
            float d = c.getResources().getDisplayMetrics().density;
            line.setColor(Color.rgb(224, 49, 49)); line.setStyle(Paint.Style.STROKE); line.setStrokeWidth(4 * d); line.setStrokeCap(Paint.Cap.ROUND); line.setStrokeJoin(Paint.Join.ROUND);
            halo.set(line); halo.setColor(Color.argb(230, 255, 255, 255)); halo.setStrokeWidth(7 * d);
            hint.setColor(Color.WHITE); hint.setTextSize(15 * d); hint.setTextAlign(Paint.Align.CENTER); hint.setFakeBoldText(true);
            pill.setColor(Color.argb(242, 15, 124, 107));
        }

        @Override
        protected void onDraw(Canvas c) {
            c.drawColor(Color.argb(10, 0, 0, 0));
            float d = getResources().getDisplayMetrics().density, cx = getWidth() / 2f, y = 64 * d;
            String t = "Circle it · tap to cancel";
            float tw = hint.measureText(t) / 2 + 18 * d;
            c.drawRoundRect(new RectF(cx - tw, y - 24 * d, cx + tw, y + 12 * d), 18 * d, 18 * d, pill);
            c.drawText(t, cx, y, hint);
            c.drawPath(path, halo);
            c.drawPath(path, line);
        }

        @Override
        public boolean onTouchEvent(MotionEvent e) {
            float x = e.getX(), y = e.getY();
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    path.reset(); path.moveTo(x, y); minX = maxX = x; minY = maxY = y; drawing = true; invalidate();
                    return true;
                case MotionEvent.ACTION_MOVE:
                    if (!drawing) return true;
                    path.lineTo(x, y); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); invalidate();
                    return true;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    drawing = false;
                    float pad = 14 * getResources().getDisplayMetrics().density;
                    if (maxX - minX < 30 || maxY - minY < 30) { endCircle(null); return true; }
                    endCircle(new RectF(Math.max(0, minX - pad), Math.max(0, minY - pad), Math.min(getWidth(), maxX + pad), Math.min(getHeight(), maxY + pad)));
                    return true;
            }
            return false;
        }
    }
}
