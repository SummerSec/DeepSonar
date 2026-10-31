.class public Lorg/deepsonar/fixture/Primary;
.super Ljava/lang/Object;

.field public static marker:Ljava/lang/String;

.method public static ping()V
    .registers 0
    return-void
.end method

.method public static probe()V
    .registers 1
    const-string v0, "asc-primary-token"
    sput-object v0, Lorg/deepsonar/fixture/Primary;->marker:Ljava/lang/String;
    const-class v0, Lorg/deepsonar/fixture/Primary;
    invoke-static {}, Lorg/deepsonar/fixture/Primary;->ping()V
    return-void
.end method
