# FocusLock ProGuard Rules

-keep class com.focuslock.accessibility.ContentBlockerService { *; }
-keep class com.focuslock.accessibility.SettingsActivity { *; }
-keep class com.focuslock.accessibility.BlockedLogActivity { *; }
-keep class com.focuslock.accessibility.BootReceiver { *; }

-keepclassmembers class com.focuslock.accessibility.** {
    *;
}

# Keep AccessibilityService annotation processing
-keep @interface android.accessibilityservice.AccessibilityService
-keepclasseswithmembers class * extends android.accessibilityservice.AccessibilityService {
    public <init>(...);
}

# Optimize for release
-optimizationpasses 5
-allowaccessmodification
-mergeinterfacesaggressively
-overloadaggressively

# Remove logging in release
-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
    public static *** i(...);
}