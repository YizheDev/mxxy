.class public Lcom/netease/my/SdkController;
.super Ljava/lang/Object;
.source "SdkController.java"

# static fields - all boolean default false
.field public static OPEN_ANNOUNCEMENT:Z = false
.field public static CLOSE_ANNOUNCEMENT:Z = false
.field public static IS_SDK_INIT:Z = true
.field public static HAS_INIT:Z = true
.field public static IS_LOGIN:Z = true
.field public static LOGIN_SUCCESS:Z = true
.field private static INST:Lcom/netease/my/SdkController;
.field private static mActivity:Landroid/app/Activity;
.field public static UID:Ljava/lang/String;
.field public static SESSION:Ljava/lang/String;

# direct methods
.method public constructor <init>()V
    .locals 0
    invoke-direct {p0}, Ljava/lang/Object;-><init>()V
    sput-object p0, Lcom/netease/my/SdkController;->INST:Lcom/netease/my/SdkController;
    return-void
.end method

# All static void methods the game might call
.method public static setActivity(Landroid/app/Activity;)V
    .locals 0
    sput-object p0, Lcom/netease/my/SdkController;->mActivity:Landroid/app/Activity;
    return-void
.end method

.method public static initWeb()V
    .locals 0
    return-void
.end method

.method public static upload_drpf()V
    .locals 0
    return-void
.end method

.method public static initDrpf()V
    .locals 0
    return-void
.end method

.method public static checkDrpf()V
    .locals 0
    return-void
.end method

.method public static drpfCallback()V
    .locals 0
    return-void
.end method

.method public static closeAnnouncement()V
    .locals 0
    return-void
.end method

.method public static openAnnouncement()V
    .locals 0
    return-void
.end method

# THE KEY METHOD - bypass login
.method public static openLoginView()V
    .locals 4
    const-string v0, "SdkController"
    const-string v1, "openLoginView OFFLINE bypass -> direct login success"
    invoke-static {v0, v1}, Landroid/util/Log;->i(Ljava/lang/String;Ljava/lang/String;)I
    sget-object v0, Lcom/netease/my/SdkController;->INST:Lcom/netease/my/SdkController;
    const-string v2, "offline_uid_001"
    const-string v3, "offline_token_001"
    invoke-virtual {v0, v2, v3}, Lcom/netease/my/SdkController;->checkLoginSucc(Ljava/lang/String;Ljava/lang/String;)V
    return-void
.end method

.method public static getPlatform()Ljava/lang/String;
    .locals 1
    const-string v0, "android"
    return-object v0
.end method

.method public static getSdkValue(Ljava/lang/String;)Ljava/lang/String;
    .locals 1
    const-string v0, "1"
    return-object v0
.end method

.method public static init()V
    .locals 3
    const-string v0, "SdkController"
    const-string v1, "init OFFLINE: init SDK + force login bypass"
    invoke-static {v0, v1}, Landroid/util/Log;->i(Ljava/lang/String;Ljava/lang/String;)I

    # Init SDK
    invoke-static {}, Lcom/netease/ntunisdk/base/SdkMgr;->getInst()Lcom/netease/ntunisdk/base/GamerInterface;
    move-result-object v0
    const/4 v1, 0x0
    invoke-interface {v0, v1}, Lcom/netease/ntunisdk/base/GamerInterface;->ntInit(Lcom/netease/ntunisdk/base/OnFinishInitListener;)V

    # Set login props directly via SdkMgr
    invoke-static {}, Lcom/netease/ntunisdk/base/SdkMgr;->getInst()Lcom/netease/ntunisdk/base/GamerInterface;
    move-result-object v0
    const-string v1, "UID"
    const-string v2, "offline_uid_001"
    invoke-interface {v0, v1, v2}, Lcom/netease/ntunisdk/base/GamerInterface;->setPropStr(Ljava/lang/String;Ljava/lang/String;)V

    invoke-static {}, Lcom/netease/ntunisdk/base/SdkMgr;->getInst()Lcom/netease/ntunisdk/base/GamerInterface;
    move-result-object v0
    const-string v1, "SESSION"
    const-string v2, "offline_token_001"
    invoke-interface {v0, v1, v2}, Lcom/netease/ntunisdk/base/GamerInterface;->setPropStr(Ljava/lang/String;Ljava/lang/String;)V

    invoke-static {}, Lcom/netease/ntunisdk/base/SdkMgr;->getInst()Lcom/netease/ntunisdk/base/GamerInterface;
    move-result-object v0
    const-string v1, "LOGIN_STAT"
    const/4 v2, 0x1
    invoke-interface {v0, v1, v2}, Lcom/netease/ntunisdk/base/GamerInterface;->setPropInt(Ljava/lang/String;I)V

    # Trigger game login success
    const-string v0, "SdkController"
    const-string v1, "init OFFLINE: calling ntGameLoginSuccess"
    invoke-static {v0, v1}, Landroid/util/Log;->i(Ljava/lang/String;Ljava/lang/String;)I

    invoke-static {}, Lcom/netease/ntunisdk/base/SdkMgr;->getInst()Lcom/netease/ntunisdk/base/GamerInterface;
    move-result-object v0
    invoke-interface {v0}, Lcom/netease/ntunisdk/base/GamerInterface;->ntGameLoginSuccess()V

    return-void
.end method

.method public static init(Landroid/content/Context;)V
    .locals 2
    const-string v0, "SdkController"
    const-string v1, "init(Context) OFFLINE"
    invoke-static {v0, v1}, Landroid/util/Log;->i(Ljava/lang/String;Ljava/lang/String;)I
    invoke-static {}, Lcom/netease/ntunisdk/base/SdkMgr;->getInst()Lcom/netease/ntunisdk/base/GamerInterface;
    move-result-object v0
    const/4 v1, 0x0
    invoke-interface {v0, v1}, Lcom/netease/ntunisdk/base/GamerInterface;->ntInit(Lcom/netease/ntunisdk/base/OnFinishInitListener;)V
    return-void
.end method

.method public static init(Landroid/app/Activity;)V
    .locals 2
    const-string v0, "SdkController"
    const-string v1, "init(Activity) OFFLINE"
    invoke-static {v0, v1}, Landroid/util/Log;->i(Ljava/lang/String;Ljava/lang/String;)I
    invoke-static {}, Lcom/netease/ntunisdk/base/SdkMgr;->getInst()Lcom/netease/ntunisdk/base/GamerInterface;
    move-result-object v0
    const/4 v1, 0x0
    invoke-interface {v0, v1}, Lcom/netease/ntunisdk/base/GamerInterface;->ntInit(Lcom/netease/ntunisdk/base/OnFinishInitListener;)V
    return-void
.end method

.method public static uploadDrpf(Ljava/lang/String;)V
    .locals 0
    return-void
.end method

.method public static uploadDrpf(Landroid/content/Context;)V
    .locals 0
    return-void
.end method


.method public static getUdid()Ljava/lang/String;
    .locals 1
    const-string v0, "offline_udid_001"
    return-object v0
.end method

.method public static getAppChannel()Ljava/lang/String;
    .locals 1
    const-string v0, "offline"
    return-object v0
.end method

.method public static getChannel()Ljava/lang/String;
    .locals 1
    const-string v0, "netease"
    return-object v0
.end method

.method public static isMuMu()Z
    .locals 1
    const/4 v0, 0x0
    return v0
.end method

.method public static uploadDrpf()V
    .locals 0
    return-void
.end method

.method public static getSdkVersion()Ljava/lang/String;
    .locals 1
    const-string v0, "1.555.0"
    return-object v0
.end method

.method public static getEngineVersion()Ljava/lang/String;
    .locals 1
    const-string v0, "1.555.0"
    return-object v0
.end method

.method public static getProjectId()Ljava/lang/String;
    .locals 1
    const-string v0, "g18"
    return-object v0
.end method

.method public static getAppKey()Ljava/lang/String;
    .locals 1
    const-string v0, "offline_key"
    return-object v0
.end method


.method public checkLoginSucc(Ljava/lang/String;Ljava/lang/String;)V
    .locals 2
    const-string v0, "SdkController"
    const-string v1, "checkLoginSucc OFFLINE: setting UID/SESSION/LOGIN_STAT"
    invoke-static {v0, v1}, Landroid/util/Log;->i(Ljava/lang/String;Ljava/lang/String;)I
    sput-object p1, Lcom/netease/my/SdkController;->UID:Ljava/lang/String;
    sput-object p2, Lcom/netease/my/SdkController;->SESSION:Ljava/lang/String;
    invoke-static {}, Lcom/netease/ntunisdk/base/SdkMgr;->getInst()Lcom/netease/ntunisdk/base/GamerInterface;
    move-result-object v0
    const-string v1, "UID"
    invoke-interface {v0, v1, p1}, Lcom/netease/ntunisdk/base/GamerInterface;->setPropStr(Ljava/lang/String;Ljava/lang/String;)V
    invoke-static {}, Lcom/netease/ntunisdk/base/SdkMgr;->getInst()Lcom/netease/ntunisdk/base/GamerInterface;
    move-result-object v0
    const-string v1, "SESSION"
    invoke-interface {v0, v1, p2}, Lcom/netease/ntunisdk/base/GamerInterface;->setPropStr(Ljava/lang/String;Ljava/lang/String;)V
    invoke-static {}, Lcom/netease/ntunisdk/base/SdkMgr;->getInst()Lcom/netease/ntunisdk/base/GamerInterface;
    move-result-object v0
    const-string v1, "LOGIN_STAT"
    const/4 p1, 0x1
    invoke-interface {v0, v1, p1}, Lcom/netease/ntunisdk/base/GamerInterface;->setPropInt(Ljava/lang/String;I)V
    invoke-virtual {p0}, Lcom/netease/my/SdkController;->gameLoginSuccess()V
    return-void
.end method

.method public gameLoginSuccess()V
    .locals 2
    const-string v0, "SdkController"
    const-string v1, "gameLoginSuccess OFFLINE"
    invoke-static {v0, v1}, Landroid/util/Log;->i(Ljava/lang/String;Ljava/lang/String;)I
    invoke-static {}, Lcom/netease/ntunisdk/base/SdkMgr;->getInst()Lcom/netease/ntunisdk/base/GamerInterface;
    move-result-object v0
    invoke-interface {v0}, Lcom/netease/ntunisdk/base/GamerInterface;->ntGameLoginSuccess()V
    return-void
.end method

.method public static showSplash()V
    .locals 0
    return-void
.end method

.method public isLogined()Z
    .locals 1
    const/4 v0, 0x1
    return v0
.end method

.method public isLoginSuccess()Z
    .locals 1
    const/4 v0, 0x1
    return v0
.end method

.method public isLoginInst()Z
    .locals 1
    const/4 v0, 0x1
    return v0
.end method

.method public hasLogin()Z
    .locals 1
    const/4 v0, 0x1
    return v0
.end method

.method public buyProduct(Ljava/lang/String;)V
    .locals 3
    const-string v0, "SdkController"
    const-string v1, "buyProduct OFFLINE: success directly"
    invoke-static {v0, v1}, Landroid/util/Log;->i(Ljava/lang/String;Ljava/lang/String;)I
    new-instance v1, Lcom/netease/ntunisdk/base/OrderInfo;
    invoke-direct {v1}, Lcom/netease/ntunisdk/base/OrderInfo;-><init>()V
    invoke-virtual {p0, v1}, Lcom/netease/my/SdkController;->orderCheckDone(Lcom/netease/ntunisdk/base/OrderInfo;)V
    return-void
.end method

.method public buyProductGas3(Ljava/lang/String;)V
    .locals 1
    invoke-virtual {p0, p1}, Lcom/netease/my/SdkController;->buyProduct(Ljava/lang/String;)V
    return-void
.end method

.method public orderCheckDone(Lcom/netease/ntunisdk/base/OrderInfo;)V
    .locals 0
    return-void
.end method

.method public logout()V
    .locals 0
    return-void
.end method

.method public login()V
    .locals 1
    invoke-virtual {p0}, Lcom/netease/my/SdkController;->openLoginView()V
    return-void
.end method

.method public relogin()V
    .locals 1
    invoke-virtual {p0}, Lcom/netease/my/SdkController;->openLoginView()V
    return-void
.end method
