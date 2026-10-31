.class public Lorg/deepsonar/fixture/Secondary;
.super Ljava/lang/Object;

.method public static probe()V
    .registers 1
    const-string v0, "asc-secondary-token"
    sget-object v0, Lorg/deepsonar/fixture/Primary;->marker:Ljava/lang/String;
    const-class v0, Lorg/deepsonar/fixture/Primary;
    invoke-static {}, Lorg/deepsonar/fixture/Primary;->ping()V
    return-void
.end method
