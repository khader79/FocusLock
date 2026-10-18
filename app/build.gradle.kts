plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val keystoreProps: Map<String, String> = rootProject.file("keystore.properties")
    .takeIf { it.exists() }
    ?.readLines()
    ?.mapNotNull { line ->
        val clean = line.substringBefore("#").trim()
        if (!clean.contains("=")) null
        else {
            val parts = clean.split("=", limit = 2)
            parts[0].trim() to parts[1].trim()
        }
    }
    ?.toMap() ?: emptyMap()

android {
    namespace = "com.focuslock.accessibility"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.focuslock.accessibility"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        create("release") {
            storeFile = keystoreProps["storeFile"]?.let { file(it) }
            storePassword = keystoreProps["storePassword"]
            keyAlias = keystoreProps["keyAlias"]
            keyPassword = keystoreProps["keyPassword"]
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            isMinifyEnabled = false
            isDebuggable = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.preference:preference-ktx:1.2.1")
    implementation("androidx.activity:activity-ktx:1.8.2")
}
