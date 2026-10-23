package app.loopnote;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(OverlayPlugin.class); // bublina přes ostatní aplikace
        super.onCreate(savedInstanceState);
    }
}
