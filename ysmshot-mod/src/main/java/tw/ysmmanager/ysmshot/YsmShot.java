package tw.ysmmanager.ysmshot;

import net.minecraftforge.api.distmarker.Dist;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.loading.FMLEnvironment;

/**
 * YSM Shot：讓「YSM 模型管理器」在遊戲內切換模型並擷取透明背景的人物畫面做縮圖。
 * 只在客戶端運作；只使用遊戲正常的渲染結果，不讀取、不修改任何 YSM 模型資料。
 */
@Mod(YsmShot.MOD_ID)
public final class YsmShot {
    public static final String MOD_ID = "ysmshot";

    public YsmShot() {
        if (FMLEnvironment.dist == Dist.CLIENT) {
            ClientBridge.start();
        }
    }
}
