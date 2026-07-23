plugins { id("com.android.application") }

android {
    namespace = "com.yizhe.mxxy.offline"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.yizhe.mxxy.offline"
        minSdk = 26; targetSdk = 34
        versionCode = 3; versionName = "0.1.0-offline"
    }
    signingConfigs {
        create("offlineDebug") {
            storeFile = file("../keystore/offline-debug.jks")
            storePassword = "mxxyoffline"; keyAlias = "mxxy-offline"; keyPassword = "mxxyoffline"
        }
    }
    buildTypes {
        debug { signingConfig = signingConfigs.getByName("offlineDebug"); isDebuggable = true }
        release { signingConfig = signingConfigs.getByName("offlineDebug"); isMinifyEnabled = false }
    }
    buildFeatures { buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies { implementation("androidx.appcompat:appcompat:1.6.1") }
