package com.tribewarez.nysiris;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * JS control surface for {@link NysirisForegroundService}.
 *
 * <p>On Android 13+ the ongoing notification needs {@code POST_NOTIFICATIONS};
 * the plugin requests it on first start and starts the service either way — a
 * hidden notification still keeps the process foreground. Registered in
 * {@link MainActivity}; JS side is {@code web/src/adapters/driven/foreground.mjs}.
 */
@CapacitorPlugin(
        name = "NysirisForeground",
        permissions = {
            @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
        })
public class NysirisForegroundPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED) {
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        startService(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        // Start regardless of the outcome: without the permission the
        // notification may be hidden, but the process still stays foreground.
        startService(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), NysirisForegroundService.class));
        JSObject ret = new JSObject();
        ret.put("running", false);
        call.resolve(ret);
    }

    private void startService(PluginCall call) {
        Intent intent = new Intent(getContext(), NysirisForegroundService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        JSObject ret = new JSObject();
        ret.put("running", true);
        call.resolve(ret);
    }
}
