package tw.ysmmanager.ysmshot;

import com.mojang.blaze3d.pipeline.TextureTarget;
import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexSorting;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.client.player.LocalPlayer;
import org.joml.Matrix4f;
import org.joml.Quaternionf;

import java.io.IOException;

/**
 * 把本地玩家（由遊戲與 YSM 正常渲染）單獨畫到一張透明背景的離屏畫布，再讀回 PNG。
 * 用的是原版背包畫面畫角色的同一個方法，所以結果和背包裡看到的一樣，只是更大、背景透明。
 */
final class PlayerSnapshot {
    private PlayerSnapshot() {}

    /** 必須在渲染執行緒呼叫。 */
    static byte[] capture(Minecraft mc, int size, float zoom, float yaw) throws IOException {
        LocalPlayer p = mc.player;
        if (p == null) throw new IllegalStateException("not_in_world");
        RenderSystem.assertOnRenderThread();

        int w = size, h = size;
        TextureTarget target = new TextureTarget(w, h, true, Minecraft.ON_OSX);
        PoseStack modelView = RenderSystem.getModelViewStack();

        float bodyRot = p.yBodyRot, bodyRotO = p.yBodyRotO;
        float yRot = p.getYRot(), yRotO = p.yRotO;
        float xRot = p.getXRot(), xRotO = p.xRotO;
        float headRot = p.yHeadRot, headRotO = p.yHeadRotO;

        RenderSystem.backupProjectionMatrix();
        modelView.pushPose();
        try {
            target.setClearColor(0f, 0f, 0f, 0f);
            target.clear(Minecraft.ON_OSX);
            target.bindWrite(true);

            RenderSystem.setProjectionMatrix(new Matrix4f().setOrtho(0f, w, h, 0f, 1000f, 3000f), VertexSorting.ORTHOGRAPHIC_Z);
            modelView.setIdentity();
            modelView.translate(0f, 0f, -2000f);
            RenderSystem.applyModelViewMatrix();

            // 讓角色面向鏡頭（與背包畫面相同的做法），yaw 可轉側面
            float facing = 180f + yaw;
            p.yBodyRot = facing;
            p.yBodyRotO = facing;
            p.setYRot(facing);
            p.yRotO = facing;
            p.setXRot(0f);
            p.xRotO = 0f;
            p.yHeadRot = facing;
            p.yHeadRotO = facing;

            GuiGraphics g = new GuiGraphics(mc, mc.renderBuffers().bufferSource());
            int scale = Math.max(1, Math.round(h / 2.7f * zoom));
            Quaternionf camera = new Quaternionf();
            Quaternionf pose = new Quaternionf().rotateZ((float) Math.PI).mul(camera);
            InventoryScreen.renderEntityInInventory(g, w / 2, Math.round(h * 0.88f), scale, pose, camera, p);
            g.flush();

            try (NativeImage img = new NativeImage(w, h, false)) {
                RenderSystem.bindTexture(target.getColorTextureId());
                img.downloadTexture(0, false);
                img.flipY();
                return img.asByteArray();
            }
        } finally {
            p.yBodyRot = bodyRot;
            p.yBodyRotO = bodyRotO;
            p.setYRot(yRot);
            p.yRotO = yRotO;
            p.setXRot(xRot);
            p.xRotO = xRotO;
            p.yHeadRot = headRot;
            p.yHeadRotO = headRotO;

            modelView.popPose();
            RenderSystem.applyModelViewMatrix();
            RenderSystem.restoreProjectionMatrix();
            target.unbindWrite();
            target.destroyBuffers();
            mc.getMainRenderTarget().bindWrite(true);
        }
    }
}
