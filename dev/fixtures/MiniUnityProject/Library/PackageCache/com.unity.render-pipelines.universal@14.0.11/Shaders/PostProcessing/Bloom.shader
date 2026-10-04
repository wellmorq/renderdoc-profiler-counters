Shader "Hidden/Universal Render Pipeline/Bloom"
{
    HLSLINCLUDE
        #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
        TEXTURE2D_X(_SourceTex);
        float4 _SourceTex_TexelSize;
        float4 _Params; // x: scatter, y: clamp, z: threshold (linear), w: threshold knee
        int _BlurTaps;
        float _Threshold; float _Scatter; float _Intensity;

        half4 FragPrefilter(Varyings input) : SV_Target
        {
            float2 uv = input.uv;
            half3 c = 0; half wsum = 0; int half_ = _BlurTaps / 2;
            for (int i = -half_; i <= half_; i++)
                for (int j = -half_; j <= half_; j++)
                {
                    float w = exp(-float(i * i + j * j) / (2.0 * float(half_ * half_ + 1)));
                    c += max(SAMPLE_TEXTURE2D_X(_SourceTex, sampler_LinearClamp, uv + float2(i, j) * _SourceTex_TexelSize.xy).rgb - _Threshold, 0) * w;
                    wsum += w;
                }
            return half4(c / wsum * _Intensity, 1);
        }
    ENDHLSL
    SubShader { Pass { Name "Bloom Prefilter" HLSLPROGRAM
        #pragma vertex Vert
        #pragma fragment FragPrefilter
    ENDHLSL } }
}
